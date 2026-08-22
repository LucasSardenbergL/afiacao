-- ============================================================================
-- farmer_association_rules — o SEGMENTO entra no lote (proveniência do denominador)
--
-- POR QUE. A Fatia 1 (#1840) corrigiu a LEITURA das cestas: o universo do Apriori saiu de 479
-- pedidos (cap silencioso de 1.000 do PostgREST) para os 30.257 reais. Mas `support` é RAZÃO,
-- e um denominador 63× maior levou o piso `s_min = 0.01` a exigir ~303 coocorrências: das 24
-- regras vigentes sobrariam **2**. As que morrem não são ruído — o lift VERDADEIRO delas no
-- universo completo vai de 2,42 a 143, e são pares óbvios do domínio de tintas.
--
-- A correção NÃO é baixar o piso (isso é recalibrar pela contagem desejada). É o DENOMINADOR:
-- as duas contas do grupo têm catálogos DISJUNTOS, e a mistura afoga o sinal da menor. Medido
-- em prod via psql-ro (2026-08-21), MESMO s_min = 0.01 e MESMO l_min = 1.2:
--
--   GLOBAL (mistura, 30.257 cestas) →  2 regras
--   colacor        (19.030 cestas)  →  2 regras
--   oben           (11.227 cestas)  → 12 regras       ── 14 no total, 7× o global
--
-- COBERTURA medida, com denominador (A = prod hoje / B = Fatia 1 sem segmentar / C = esta):
--   MixGap        (525 clientes de carteira elegível/12m):  A=116 (22,1%) · B=0 (0,0%) · C=84 (16,0%)
--   recommend+cross-sell (1.208 clientes com histórico):    A=266 (22,0%) · B=250 (20,7%) · C=351 (29,1%)
--   melhoria      (3.143 SKUs ativos que são antecedente):  A=14          · B=0          · C=8
-- B é a Fatia 1 sozinha: correta, e ZERA o MixGap e o canal Melhorias. C recupera os dois.
--
-- O QUE ESTA MIGRATION FAZ, e o que NÃO faz:
--   · A RPC passa a LER `cluster_segment` do lote e a gravá-lo. Antes o campo era ignorado pelo
--     `jsonb_to_recordset` (que só extrai as colunas declaradas) — mandá-lo do lado da edge sem
--     esta migration seria escrita silenciosamente descartada.
--   · Recusa (TR006) regra sem segmento. Uma regra cujo `support` não diz de que denominador
--     veio é exatamente o defeito que a fatia corrige; aceitá-la "por enquanto" reporia o
--     problema pela porta dos fundos, com cara de dado bom (money-path §2 — ausente ≠ zero).
--   · NÃO muda o gate, o advisory lock, os TR001-TR005, o `WHERE true` do DELETE, nem a
--     transação única. O desenho de substituição segue LOTE ÚNICO com os dois segmentos juntos:
--     `DELETE WHERE cluster_segment = …` por segmento quebraria a atomicidade que o #1840
--     construiu e criaria o estado misto "colacor novo + oben velho" sem nada que o denuncie.
--   · NÃO toca nas 24 linhas vigentes (todas com cluster_segment NULL). O próximo recompute as
--     substitui inteiras — por isso o CHECK nasce NOT VALID (ver abaixo).
--
-- `CREATE OR REPLACE`, nunca DROP+CREATE: o DROP RESETARIA o ACL e desfaria o REVOKE de
-- `authenticated` que a `20260820225840` aplicou (o fence de escritor único). Conferido em prod
-- antes de escrever: `has_function_privilege('authenticated', …, 'EXECUTE')` = false.
-- Corpo reescrito a partir do corpo VIVO em prod (`pg_get_functiondef`), não do repo.
--
-- ⚠️ ORDEM DE DEPLOY: esta migration PRIMEIRO, o deploy da edge DEPOIS. Entre os dois, o cron
--    `compute-association-rules-daily` falha com TR006 — ruidoso e fail-closed. Na ordem
--    inversa a edge nova mandaria `cluster_segment` para a RPC velha, que o descartaria em
--    silêncio e publicaria 14 regras sem proveniência: verde na tela, errado na tabela.
-- ============================================================================

-- ── 1) A INVARIANTE NA TABELA ────────────────────────────────────────────────────────────────
-- O guard mora no writer (TR006 abaixo); a invariante mora na TABELA. `service_role` bypassa
-- RLS e pode escrever direto via PostgREST sem passar pela RPC — sem o CHECK, essa via publica
-- regra sem proveniência. NOT VALID porque as 24 linhas vigentes são anteriores ao conceito:
-- valida toda linha NOVA e deixa as antigas em paz até o primeiro recompute apagá-las.
-- (Depois do primeiro recompute o `VALIDATE CONSTRAINT` fica disponível — está na query de
-- validação pós-apply, no fim deste arquivo, como passo separado e opcional.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.farmer_association_rules'::regclass
      AND conname  = 'farmer_association_rules_cluster_segment_check'
  ) THEN
    ALTER TABLE public.farmer_association_rules
      ADD CONSTRAINT farmer_association_rules_cluster_segment_check
      CHECK (cluster_segment IS NOT NULL AND length(btrim(cluster_segment)) > 0) NOT VALID;
  END IF;
END $$;

-- ── 1b) O SENSOR DE AMBIGUIDADE ENTRE CONTAS ────────────────────────────────────────────────
-- O isolamento entre as duas contas NÃO é garantido por chave: a UNIQUE de `omie_products` é
-- `(omie_codigo_produto, account)`, então o mesmo código pode legitimamente existir nas duas.
-- E `_carteira_mixgap_for_owner` casa o histórico do cliente por
--   `oi.product_id = op.id OR (oi.product_id IS NULL AND oi.omie_codigo_produto = op.omie_codigo_produto)`
-- — o segundo ramo SEM qualificar a conta, sobre 1.839 linhas de `order_items` com product_id
-- nulo e código preenchido. Se um código passar a existir nas duas contas, um item de colacor
-- materializa também o id de oben e uma regra de oben alcança o cliente errado.
-- Medido em prod (2026-08-21): 0 códigos em mais de uma conta. Ou seja, hoje o isolamento é
-- fato do DADO, não do desenho — então o produtor MEDE a cada execução em vez de assumir, e
-- para de publicar se deixar de ser 0 (achado do challenge Codex xhigh).
--
-- SECURITY INVOKER (o default, declarado aqui por ser afirmação de segurança e não descuido):
-- a função NÃO bypassa nada, herda a RLS de `omie_products` (policy `omie_products_select_staff`,
-- SELECT-only) e por isso não precisa de gate próprio nem amplia superfície — quem já podia ler
-- a tabela lê o agregado, quem não podia recebe zero linhas. A edge roda sob `service_role`,
-- que bypassa RLS, e enxerga o catálogo inteiro.
CREATE OR REPLACE FUNCTION public.omie_products_codigos_multi_conta()
RETURNS TABLE (omie_codigo_produto text, contas bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  SELECT op.omie_codigo_produto, count(DISTINCT op.account) AS contas
  FROM public.omie_products op
  WHERE op.omie_codigo_produto IS NOT NULL
  GROUP BY op.omie_codigo_produto
  HAVING count(DISTINCT op.account) > 1
  ORDER BY op.omie_codigo_produto
$function$;

COMMENT ON FUNCTION public.omie_products_codigos_multi_conta() IS
  'Sensor: códigos de produto que existem em MAIS DE UMA conta. Espera-se 0 — o fallback por '
  'código do MixGap (product_id nulo) não qualifica a conta, então um código repetido faria '
  'regra de associação de uma conta alcançar cliente da outra. SECURITY INVOKER: herda a RLS.';

REVOKE EXECUTE ON FUNCTION public.omie_products_codigos_multi_conta() FROM anon;

-- ── 2) A RPC ────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.farmer_association_rules_substituir(p_regras jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total     integer;
  v_invalidas integer;
  v_sem_seg   integer;
  v_inseridas integer;
BEGIN
  -- 1) GATE (a função bypassa RLS: a autorização é AQUI, na fronteira)
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

  -- 3) LOTE VAZIO = RECUSA, não "apaga tudo".
  IF v_total = 0 THEN
    RAISE EXCEPTION 'lote vazio: as % regra(s) atuais foram preservadas',
      (SELECT count(*) FROM public.farmer_association_rules) USING ERRCODE = 'TR001';
  END IF;

  -- Teto defensivo. O `max_association_rules` da edge é POR SEGMENTO (default 500) e este teto
  -- é do LOTE INTEIRO — com 2 contas o limite é justo; a edge falha antes, dizendo o número.
  IF v_total > 1000 THEN
    RAISE EXCEPTION 'lote de % regras excede o teto de 1000', v_total USING ERRCODE = 'TR003';
  END IF;

  -- 4) SERIALIZAÇÃO (lock transacional: sai sozinho no commit/rollback).
  IF NOT pg_try_advisory_xact_lock(hashtext('farmer_association_rules_substituir')) THEN
    RAISE EXCEPTION 'outra substituição de regras está em andamento — nada foi alterado'
      USING ERRCODE = 'TR004';
  END IF;

  -- 5) VALIDAÇÃO ANTES DE DESTRUIR.
  SELECT count(*) INTO v_invalidas
  FROM jsonb_to_recordset(p_regras) AS r(
    antecedent_product_ids text[],
    consequent_product_ids text[],
    support                numeric,
    confidence             numeric,
    lift                   numeric,
    rule_type              text,
    sample_size            integer,
    cluster_segment        text
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

  -- 5b) PROVENIÊNCIA (TR006). Separado do TR005 de propósito: "o número está fora da faixa" e
  -- "o número não diz de que universo veio" são defeitos diferentes, e quem lê o erro precisa
  -- saber qual dos dois aconteceu. `support` é razão sobre o universo DO SEGMENTO; sem o
  -- segmento, o consumidor compara razões de denominadores que ele não conhece.
  SELECT count(*) INTO v_sem_seg
  FROM jsonb_to_recordset(p_regras) AS r(cluster_segment text)
  WHERE r.cluster_segment IS NULL OR length(btrim(r.cluster_segment)) = 0;

  IF v_sem_seg > 0 THEN
    RAISE EXCEPTION
      '% de % regra(s) sem cluster_segment — o support publicado não diria de que universo veio; nada foi apagado',
      v_sem_seg, v_total USING ERRCODE = 'TR006';
  END IF;

  -- 5c) PERDA PARCIAL DE SEGMENTO (TR007). O buraco que o LOTE ÚNICO abre e que o TR001 NÃO
  -- cobre: um lote com 12 regras de oben e ZERO de colacor não está vazio, passa em tudo, e
  -- APAGA colacor. Nada erraria, nada alertaria, e o sintoma seria "as regras de uma conta
  -- sumiram". Mesma família do TR001 ("lote vazio não é motivo para apagar o que vale"), um
  -- nível abaixo: aqui o lote é parcial em vez de vazio.
  -- A comparação é com o que JÁ ESTÁ PUBLICADO, porque é isso que a RPC consegue saber sozinha
  -- — um array de regras não distingue "segmento processado, zero regras" de "segmento
  -- esquecido por bug". A outra metade mora no produtor, que conhece os segmentos PROCESSADOS.
  -- Na primeira execução a tabela só tem linhas de cluster_segment NULL, então não há segmento
  -- vigente para perder e a checagem é inócua — por construção, não por sorte.
  SELECT count(*) INTO v_sem_seg
  FROM (
    SELECT DISTINCT cluster_segment AS seg
    FROM public.farmer_association_rules
    WHERE cluster_segment IS NOT NULL
    EXCEPT
    SELECT DISTINCT btrim(r.cluster_segment)
    FROM jsonb_to_recordset(p_regras) AS r(cluster_segment text)
    WHERE r.cluster_segment IS NOT NULL
  ) faltantes;

  IF v_sem_seg > 0 THEN
    RAISE EXCEPTION
      'o lote perde % segmento(s) já publicado(s) (%) — publicá-lo apagaria as regras dessa(s) conta(s) sem que nada denuncie a perda; nada foi apagado',
      v_sem_seg,
      (SELECT string_agg(seg, ', ' ORDER BY seg) FROM (
         SELECT DISTINCT cluster_segment AS seg FROM public.farmer_association_rules WHERE cluster_segment IS NOT NULL
         EXCEPT
         SELECT DISTINCT btrim(r2.cluster_segment) FROM jsonb_to_recordset(p_regras) AS r2(cluster_segment text) WHERE r2.cluster_segment IS NOT NULL
       ) f)
      USING ERRCODE = 'TR007';
  END IF;

  -- 6) A TROCA. Os dois statements na MESMA transação.
  -- ⚠️ `WHERE true` NÃO é decoração — é o que mantém esta função CHAMÁVEL.
  --    O Supabase pré-carrega o módulo `safeupdate` na sessão do `authenticator`
  --    (o role do PostgREST). O post_parse_analyze_hook dele RECUSA, com ERRCODE
  --    21000, todo DELETE/UPDATE cujo `jointree->quals` seja NULL na árvore de
  --    PARSE — inclusive dentro de plpgsql SECURITY DEFINER, porque o DEFINER
  --    troca o ROLE e não o hook, que é de SESSÃO. Sem o WHERE, toda chamada via
  --    PostgREST morre com "DELETE requires a WHERE clause" (incidente 2026-07-29).
  --    O planner dobra o `true` fora: o plano é o mesmo do DELETE sem WHERE.
  DELETE FROM public.farmer_association_rules WHERE true;

  INSERT INTO public.farmer_association_rules (
    antecedent_product_ids, consequent_product_ids,
    support, confidence, lift, rule_type, sample_size, cluster_segment
  )
  SELECT
    r.antecedent_product_ids, r.consequent_product_ids,
    r.support, r.confidence, r.lift, r.rule_type, coalesce(r.sample_size, 0), btrim(r.cluster_segment)
  FROM jsonb_to_recordset(p_regras) AS r(
    antecedent_product_ids text[],
    consequent_product_ids text[],
    support                numeric,
    confidence             numeric,
    lift                   numeric,
    rule_type              text,
    sample_size            integer,
    cluster_segment        text
  );

  GET DIAGNOSTICS v_inseridas = ROW_COUNT;
  RETURN v_inseridas;
END;
$function$;

COMMENT ON FUNCTION public.farmer_association_rules_substituir(jsonb) IS
  'Troca ATÔMICA do lote de regras de associação (DELETE+INSERT numa transação). Lote ÚNICO com '
  'TODOS os segmentos: cada regra carrega cluster_segment e o sample_size do SEU universo. '
  'Recusa lote vazio (TR001), formato (TR002), teto de 1000 (TR003), concorrência (TR004), '
  'valor fora de faixa (TR005), regra sem proveniência (TR006) e lote que PERDE um segmento '
  'já publicado (TR007).';

-- ── 3) O ACL NÃO MUDA ───────────────────────────────────────────────────────────────────────
-- `CREATE OR REPLACE` PRESERVA o ACL, então o REVOKE da `20260820225840` continua de pé. O
-- REVOKE abaixo é idempotente e nomeia as roles — reemiti-lo é barato e fecha a janela caso
-- esta função algum dia seja recriada por DROP+CREATE em outro caminho (database.md §4).
REVOKE EXECUTE ON FUNCTION public.farmer_association_rules_substituir(jsonb) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.farmer_association_rules_substituir(jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.farmer_association_rules_substituir(jsonb) FROM PUBLIC;

-- ============================================================================
-- VALIDAÇÃO PÓS-APPLY (read-only — cole no SQL Editor depois do Run)
-- ============================================================================
-- SELECT
--   (SELECT count(*) FROM pg_constraint
--     WHERE conrelid = 'public.farmer_association_rules'::regclass
--       AND conname = 'farmer_association_rules_cluster_segment_check')            AS check_criado_esperado_1,
--   (SELECT pg_get_functiondef(oid) ~ 'TR006' AND pg_get_functiondef(oid) ~ 'TR007' FROM pg_proc p
--      JOIN pg_namespace n ON n.oid = p.pronamespace
--     WHERE n.nspname = 'public' AND p.proname = 'farmer_association_rules_substituir')
--                                                                            AS rpc_tem_tr006_e_tr007_esperado_t,
--   (SELECT has_function_privilege('authenticated',
--       'public.farmer_association_rules_substituir(jsonb)', 'EXECUTE'))          AS authenticated_executa_esperado_f,
--   (SELECT count(*) FROM public.farmer_association_rules)                        AS regras_vigentes_intactas;
--
-- DEPOIS do primeiro recompute com a edge nova (quando nenhuma linha tiver segmento NULL),
-- o CHECK pode deixar de ser NOT VALID — passo separado, e só depois de conferir o zero:
--   SELECT count(*) FROM public.farmer_association_rules WHERE cluster_segment IS NULL;  -- espere 0
--   ALTER TABLE public.farmer_association_rules VALIDATE CONSTRAINT farmer_association_rules_cluster_segment_check;
