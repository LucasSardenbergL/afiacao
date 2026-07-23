-- ============================================================
-- farmer_association_rules_substituir — troca ATÔMICA do lote global de regras
--
-- PROBLEMA (pré-existente, commit 9892dd88): os DOIS writers da tabela faziam
-- `DELETE` de tudo e depois `INSERT`, em chamadas PostgREST SEPARADAS e com o
-- `error` descartado:
--   · src/hooks/useBundleEngine.ts            (browser, staff clica "calcular bundles")
--   · supabase/functions/omie-analytics-sync  (edge, action compute_association_rules)
-- Falha de rede/permissão entre as duas chamadas deixa a tabela VAZIA — e ela é
-- GLOBAL (sem farmer_id), então o estrago é de toda a base. Cinco consumidores
-- dependem dela e nenhum sabe distinguir "sem regra" de "tabela zerada":
--   1. _carteira_mixgap_for_owner → get_meu_mixgap  → card MixGap em FarmerCalls
--   2. melhoria_produtos_relacionados               → canal Melhorias (em prod)
--   3. supabase/functions/recommend                 → assoc_score (peso w_assoc, 0.25)
--   4. src/hooks/useCrossSellEngine                 → cross-sell do farmer
--   5. o próprio bundle engine, na execução seguinte
--
-- CONSERTO: um único statement — DELETE + INSERT dentro da MESMA transação.
-- Qualquer falha faz rollback e as regras ANTIGAS sobrevivem. Três garantias a mais:
--   · payload validado ANTES do DELETE (mensagem útil em vez de rollback opaco);
--   · lote vazio é RECUSADO (fail-closed) — "não achei regra" quase sempre é dado
--     faltando a montante, e zerar a tabela derruba 4 features de uma vez;
--   · advisory lock transacional serializa dois recálculos concorrentes, que hoje
--     conseguem intercalar DELETE/INSERT e DUPLICAR o lote inteiro.
--
-- SECURITY DEFINER: espelha a policy "Staff can manage association rules" e soma
-- o service_role (a edge roda com service key, `auth.uid()` nulo). A semântica é
-- "substitua TUDO", que precisa enxergar a tabela inteira independentemente de RLS.
-- ============================================================

CREATE OR REPLACE FUNCTION public.farmer_association_rules_substituir(p_regras jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total     integer;
  v_invalidas integer;
  v_inseridas integer;
BEGIN
  -- 1) GATE (a função bypassa RLS: a autorização é AQUI, na fronteira)
  --    `coalesce(auth.role(), '')`, não `auth.role() = ...`: sem JWT a função devolve
  --    NULL, `NULL = 'service_role'` é NULL, `NOT (NULL OR false OR false)` é NULL — e
  --    `IF NULL THEN` NÃO entra no ramo. O gate falharia ABERTO, deixando customer
  --    substituir as regras. Pego pelo assert A4 do harness PG17.
  IF NOT (
    coalesce(auth.role(), '') = 'service_role'
    OR public.has_role(auth.uid(), 'master'::public.app_role)
    OR public.has_role(auth.uid(), 'employee'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  -- 2) FORMATO
  IF p_regras IS NULL OR jsonb_typeof(p_regras) <> 'array' THEN
    RAISE EXCEPTION 'p_regras deve ser um array jsonb (recebido: %)',
      coalesce(jsonb_typeof(p_regras), 'null') USING ERRCODE = 'TR002';
  END IF;

  v_total := jsonb_array_length(p_regras);

  -- 3) LOTE VAZIO = RECUSA, não "apaga tudo". Substituir por nada é destruição
  --    disfarçada de resultado; quem quiser mesmo esvaziar faz DELETE explícito.
  IF v_total = 0 THEN
    RAISE EXCEPTION 'lote vazio: as % regra(s) atuais foram preservadas',
      (SELECT count(*) FROM public.farmer_association_rules) USING ERRCODE = 'TR001';
  END IF;

  -- Teto defensivo: acima do maior lote que os callers produzem
  -- (browser 50; edge `max_association_rules`, default 500).
  IF v_total > 1000 THEN
    RAISE EXCEPTION 'lote de % regras excede o teto de 1000', v_total USING ERRCODE = 'TR003';
  END IF;

  -- 4) SERIALIZAÇÃO. `try` em vez de esperar na fila: dois recálculos simultâneos
  --    calculam o MESMO lote, então enfileirar só gasta o timeout do PostgREST.
  --    O lock é _xact_: sai sozinho no commit/rollback.
  IF NOT pg_try_advisory_xact_lock(hashtext('farmer_association_rules_substituir')) THEN
    RAISE EXCEPTION 'outra substituição de regras está em andamento — nada foi alterado'
      USING ERRCODE = 'TR004';
  END IF;

  -- 5) VALIDAÇÃO ANTES DE DESTRUIR. O rollback já protegeria a tabela, mas um
  --    payload torto tem que virar mensagem legível, não erro de cast.
  SELECT count(*) INTO v_invalidas
  FROM jsonb_to_recordset(p_regras) AS r(
    antecedent_product_ids text[],
    consequent_product_ids text[],
    support                numeric,
    confidence             numeric,
    lift                   numeric,
    rule_type              text,
    sample_size            integer
  )
  WHERE r.antecedent_product_ids IS NULL OR cardinality(r.antecedent_product_ids) = 0
     OR r.consequent_product_ids IS NULL OR cardinality(r.consequent_product_ids) = 0
     OR r.support    IS NULL OR r.support    < 0 OR r.support    > 1
     OR r.confidence IS NULL OR r.confidence < 0 OR r.confidence > 1
     OR r.lift       IS NULL OR r.lift       < 0
     OR r.rule_type  IS NULL OR r.rule_type NOT IN ('association', 'sequential');

  IF v_invalidas > 0 THEN
    RAISE EXCEPTION '% de % regra(s) inválidas — nada foi apagado', v_invalidas, v_total
      USING ERRCODE = 'TR005';
  END IF;

  -- 6) A TROCA. Os dois statements na MESMA transação: o INSERT falhando desfaz
  --    o DELETE, que é a garantia inteira desta função.
  DELETE FROM public.farmer_association_rules;

  INSERT INTO public.farmer_association_rules (
    antecedent_product_ids, consequent_product_ids,
    support, confidence, lift, rule_type, sample_size
  )
  SELECT
    r.antecedent_product_ids, r.consequent_product_ids,
    r.support, r.confidence, r.lift, r.rule_type, coalesce(r.sample_size, 0)
  FROM jsonb_to_recordset(p_regras) AS r(
    antecedent_product_ids text[],
    consequent_product_ids text[],
    support                numeric,
    confidence             numeric,
    lift                   numeric,
    rule_type              text,
    sample_size            integer
  );

  GET DIAGNOSTICS v_inseridas = ROW_COUNT;
  RETURN v_inseridas;
END;
$$;

COMMENT ON FUNCTION public.farmer_association_rules_substituir(jsonb) IS
  'Substitui ATOMICAMENTE o lote global de farmer_association_rules (DELETE+INSERT numa transação). '
  'Recusa lote vazio (TR001) e payload inválido (TR005) sem apagar nada; serializa concorrentes (TR004). '
  'Único caminho de escrita destrutiva: useBundleEngine e omie-analytics-sync.';

-- Grants: a função é DEFINER, então a porta é o EXECUTE. `anon` fica de fora.
REVOKE ALL ON FUNCTION public.farmer_association_rules_substituir(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.farmer_association_rules_substituir(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.farmer_association_rules_substituir(jsonb) TO authenticated, service_role;
