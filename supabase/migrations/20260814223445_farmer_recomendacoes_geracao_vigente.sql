-- ============================================================
-- Geração VIGENTE das recomendações do farmer — o recálculo passa a APOSENTAR
-- a geração anterior, em vez de empilhar por cima dela.
--
-- PROBLEMA (medido em prod 2026-08-14, achado do challenge Codex xhigh no #1520):
--   `useCrossSellEngine` faz `.upsert(recRows)` SEM `onConflict` e sem `id` no
--   payload — como a única chave é o uuid DEFAULT, nada nunca colide e o upsert é,
--   na prática, um INSERT. `useBundleEngine` faz `.insert()` explícito. Nenhum dos
--   dois aposenta o que gravou antes.
--   Os leitores pegam `status='pendente'` ordenado por afinidade desc com
--   `.limit(1)`/`.limit(2)` — então uma recomendação ANTIGA com score maior
--   permanece "top" para sempre. O recálculo não substitui: só empilha.
--
--   Medido em prod via psql-ro (2026-08-15 00:5x UTC). farmer_recommendations:
--   6.015 linhas, 100% status='pendente', ZERO desfecho (offered_at/accepted_at/
--   rejected_at/actual_margin nulos em TODAS), 7 execuções entre 02/03 e 15/08.
--     · 473 grupos (farmer_id, customer_user_id) com pendentes
--     · 276 com 1 geração · 138 com 2 · 33 com 3 · 26 com 4+
--     · 197 grupos (42%) com ≥2 gerações vivas, concentrando 4.535 das 6.015
--       linhas (75%)
--   E o bug JÁ se manifestou: medido pela chave de ranking vigente à época (p_ij,
--   antes do #1520 mover o ranking para affinity_score), 18 grupos tinham como
--   TOPO uma linha de até 70 DIAS antes. Hoje ele está temporariamente MASCARADO
--   porque só a última geração (1.342 linhas) tem affinity_score preenchido e os
--   leitores filtram `.not('affinity_score','is',null)` — as antigas estão
--   acidentalmente invisíveis. Isso acaba na PRÓXIMA execução do motor, quando
--   houver duas gerações com afinidade competindo. O motor rodou 3x nas 2h
--   anteriores a esta medição, então "próxima execução" não é hipotético.
--   farmer_bundle_recommendations: 12 linhas, 2 execuções separadas por 4 minutos,
--   4 grupos — 2 deles já com as duas gerações vivas. Mesmo defeito, volume menor.
--
-- DESENHO: `run_id` por execução + RPC transacional que expira e insere numa
--   transação só. Duas chamadas PostgREST (UPDATE depois INSERT) são duas
--   transações: falha entre elas deixaria o farmer SEM nenhuma oferta pendente.
--   Mesmo motivo que levou `farmer_association_rules_substituir` a existir.
--
-- EXPIRAR ≠ DELETAR: `status` guarda o desfecho ('ofertado'/'aceito'/'rejeitado')
--   junto de `accepted_at`/`rejected_at`. A RPC só toca `status='pendente'` —
--   linha com desfecho registrado é IMUTÁVEL aqui (money-path: "deleção exige
--   prova positiva de ausência"). Medido: hoje 100% das linhas das duas tabelas
--   são 'pendente' com ZERO desfecho (os métodos `markAsOffered`/`markAsAccepted`
--   foram removidos em 2026-07-21 por não terem consumidor), então a expiração
--   não destrói histórico nenhum — mas o guard fica, porque o loop de feedback é
--   follow-up conhecido e vai começar a gravar desfecho. Ou seja: o guard nasce
--   INERTE e é declarado como tal. Vale escrevê-lo porque defesa inerte tem prazo
--   de validade curto neste repo — o precedente do #1495/#1498 saiu de inerte para
--   ativa em 7 horas.
--
-- DEPENDE de 20260725121000 (colunas affinity_score/affinity_bundle do #1520).
--   O bloco de guard abaixo ABORTA com instrução explícita se ela não tiver sido
--   aplicada — em vez de morrer com um 42703 críptico no meio do apply.
-- ============================================================

-- ─── 0) Guard de ordem de apply (fail-closed, com a instrução no texto) ───
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'farmer_recommendations'
      AND column_name = 'affinity_score'
  ) THEN
    RAISE EXCEPTION 'DEPENDENCIA FALTANDO: aplique ANTES a migration 20260725121000_authz_custo_fu4f_fase3_afinidade_colunas.sql (coluna farmer_recommendations.affinity_score ausente nesta base)'
      USING ERRCODE = 'FG000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'farmer_bundle_recommendations'
      AND column_name = 'affinity_bundle'
  ) THEN
    RAISE EXCEPTION 'DEPENDENCIA FALTANDO: aplique ANTES a migration 20260725121000_authz_custo_fu4f_fase3_afinidade_colunas.sql (coluna farmer_bundle_recommendations.affinity_bundle ausente nesta base)'
      USING ERRCODE = 'FG000';
  END IF;
END $$;

-- ─── 1) Colunas de geração ───
ALTER TABLE public.farmer_recommendations
  ADD COLUMN IF NOT EXISTS run_id         uuid,
  ADD COLUMN IF NOT EXISTS expired_at     timestamptz,
  ADD COLUMN IF NOT EXISTS expired_by_run uuid;

ALTER TABLE public.farmer_bundle_recommendations
  ADD COLUMN IF NOT EXISTS run_id         uuid,
  ADD COLUMN IF NOT EXISTS expired_at     timestamptz,
  ADD COLUMN IF NOT EXISTS expired_by_run uuid;

COMMENT ON COLUMN public.farmer_recommendations.run_id IS
  'Execução do motor que produziu esta linha. NULL = geração legada (anterior a 2026-08-14). A geração VIGENTE de um farmer é o run_id das linhas status=pendente.';
COMMENT ON COLUMN public.farmer_recommendations.expired_at IS
  'Quando a linha foi aposentada por um recálculo. Só preenchido junto de status=expirado (invariante em CHECK).';
COMMENT ON COLUMN public.farmer_recommendations.expired_by_run IS
  'Qual execução aposentou esta linha — responde "quem matou" sem precisar inferir pela ordem de created_at.';

-- ─── 2) `expirado` no CHECK do bundle ───
-- farmer_recommendations JÁ aceita 'expirado'; farmer_bundle_recommendations NÃO
-- (medido: ARRAY['pendente','ofertado','aceito_total','aceito_parcial','rejeitado']).
-- Sem isto a RPC do bundle falharia em RUNTIME com 23514, não no CREATE.
ALTER TABLE public.farmer_bundle_recommendations
  DROP CONSTRAINT IF EXISTS farmer_bundle_recommendations_status_check;
ALTER TABLE public.farmer_bundle_recommendations
  ADD CONSTRAINT farmer_bundle_recommendations_status_check
  CHECK (status = ANY (ARRAY['pendente'::text, 'ofertado'::text, 'aceito_total'::text,
                             'aceito_parcial'::text, 'rejeitado'::text, 'expirado'::text]));

-- ─── 3) Invariante na TABELA, não só no writer ───
-- "O guard mora no WRITER; a invariante mora na TABELA" (money-path §2): o próximo
-- writer que marcar 'expirado' sem carimbar `expired_at` produz uma linha que some
-- dos leitores sem deixar rastro de QUANDO sumiu. Medido antes de propor: hoje 0
-- linhas violam (100% 'pendente', expired_at nasce NULL), então o ADD valida limpo.
-- Tabelas pequenas (936 kB e 32 kB) — ADD direto não precisa de NOT VALID.
-- ⚠️ `status IS NOT NULL AND` na frente não é redundante: `status` é NULLABLE, e com
-- status NULL a igualdade `(NULL = 'expirado') = (…)` vira NULL — que o Postgres
-- ACEITA num CHECK (só `false` reprova). Sem esse termo, um writer que gravasse
-- status NULL passaria pela constraint, sumiria de todo leitor (que filtra por status)
-- e ainda entraria no denominador da adoção. É o mesmo three-valued logic do gate.
ALTER TABLE public.farmer_recommendations
  DROP CONSTRAINT IF EXISTS farmer_recommendations_expirado_coerente;
ALTER TABLE public.farmer_recommendations
  ADD CONSTRAINT farmer_recommendations_expirado_coerente
  CHECK (status IS NOT NULL AND ((status = 'expirado') = (expired_at IS NOT NULL)));

ALTER TABLE public.farmer_bundle_recommendations
  DROP CONSTRAINT IF EXISTS farmer_bundle_recommendations_expirado_coerente;
ALTER TABLE public.farmer_bundle_recommendations
  ADD CONSTRAINT farmer_bundle_recommendations_expirado_coerente
  CHECK (status IS NOT NULL AND ((status = 'expirado') = (expired_at IS NOT NULL)));

-- ─── 4) Índices ───
-- As duas tabelas tinham SÓ a PK: todo leitor (`farmer_id` + `status='pendente'`)
-- e o UPDATE de expiração faziam seq scan.
CREATE INDEX IF NOT EXISTS idx_frec_farmer_status_pendente
  ON public.farmer_recommendations (farmer_id, customer_user_id)
  WHERE status = 'pendente';
CREATE INDEX IF NOT EXISTS idx_fbrec_farmer_status_pendente
  ON public.farmer_bundle_recommendations (farmer_id, customer_user_id)
  WHERE status = 'pendente';

-- ─── 4b) A INVARIANTE MORA NA TABELA, não na convenção dos dois hooks ───
-- Sem isto, o compare-and-swap é só um protocolo cooperativo: qualquer `.insert()`
-- direto (uma aba com o JS antigo durante a janela de deploy, um script, um hook
-- futuro) grava uma linha `pendente` com run_id NULL, que não toma o advisory lock,
-- sobrevive à substituição e volta a competir no topo — o bug original de volta, e
-- nenhum dos guards da RPC o veria. "O guard mora no WRITER; a invariante mora na
-- TABELA" (money-path §2).
--
-- Só BEFORE INSERT: o UPDATE de expiração e os updates de argumento
-- (useBundleArguments) precisam seguir funcionando sobre linhas legadas.
-- As 6.015 linhas pendentes já existentes (run_id NULL) NÃO são afetadas — trigger de
-- INSERT não revalida o passado; elas saem no primeiro recálculo de cada farmer.
--
-- ⚠️ ORDEM DE DEPLOY: entre esta migration e o Publish do frontend, uma aba com o JS
-- antigo que clique em "Recalcular" recebe FG008 em vez de gravar. É deliberado e é o
-- lado seguro: o toast do front antigo já diz "N recomendações NÃO foram gravadas — as
-- telas seguem com as anteriores", que é verdade. O outro lado seria empilhar em
-- silêncio, que é exatamente o defeito sendo corrigido.
CREATE OR REPLACE FUNCTION public.farmer_rec_exige_run_id() RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'pendente' AND NEW.run_id IS NULL THEN
    RAISE EXCEPTION 'recomendação pendente exige run_id: use as RPCs farmer_recomendacoes_substituir / farmer_bundle_recomendacoes_substituir (INSERT direto EMPILHA em vez de substituir a geração)'
      USING ERRCODE = 'FG008';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_frec_exige_run_id ON public.farmer_recommendations;
CREATE TRIGGER trg_frec_exige_run_id
  BEFORE INSERT ON public.farmer_recommendations
  FOR EACH ROW EXECUTE FUNCTION public.farmer_rec_exige_run_id();

DROP TRIGGER IF EXISTS trg_fbrec_exige_run_id ON public.farmer_bundle_recommendations;
CREATE TRIGGER trg_fbrec_exige_run_id
  BEFORE INSERT ON public.farmer_bundle_recommendations
  FOR EACH ROW EXECUTE FUNCTION public.farmer_rec_exige_run_id();

-- ============================================================
-- 5) RPC — cross-sell / up-sell
-- ============================================================
-- SECURITY INVOKER (o default, declarado de propósito): a RLS destas tabelas JÁ
-- expressa exatamente a regra desejada (`farmer_id = auth.uid()` OU
-- `private.cap_carteira_escrever(auth.uid())`). Com DEFINER eu teria de REPLICAR
-- esse predicado no corpo — e uma cópia que diverge vira escalação: um employee
-- passaria `p_farmer_id` de outra vendedora e expiraria a carteira dela. Deixando
-- INVOKER, a autoridade continua sendo a policy, com uma fonte de verdade só.
-- O gate explícito abaixo existe para a MENSAGEM (sem ele o UPDATE afetaria 0
-- linhas e o INSERT morreria com um 42501 cru da RLS), não para autorizar.
CREATE OR REPLACE FUNCTION public.farmer_recomendacoes_substituir(
  p_farmer_id     uuid,
  p_run_id        uuid,
  p_geracao_vista uuid,
  p_linhas        jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total          integer;
  v_invalidas      integer;
  v_geracao_atual  uuid;
  v_expiradas      integer;
  v_inseridas      integer;
BEGIN
  -- 1) Gate de MENSAGEM (a RLS é quem autoriza — ver cabeçalho).
  IF p_farmer_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'p_farmer_id e p_run_id são obrigatórios' USING ERRCODE = 'FG001';
  END IF;
  -- ⚠️ `IS NOT TRUE`, não `NOT (...)`. Numa sessão SEM JWT (pg_cron, psql) `auth.uid()`
  -- devolve NULL, então `p_farmer_id = auth.uid()` é NULL e a disjunção inteira vira
  -- NULL — e `IF NOT NULL THEN` NÃO dispara em PL/pgSQL. Medido em prod:
  --   NOT (false OR NULL OR false)          => NULL   (o RAISE nunca acontece)
  --   (false OR NULL OR false) IS NOT TRUE  => true   (barra, como se quer)
  -- Ou seja, a forma "óbvia" é um guard que não nega: ele devolve nulo. Fecha-se em
  -- TRUE explícito — só quem provou ter direito passa (money-path: fail-closed).
  IF (
    coalesce(auth.role(), '') = 'service_role'
    OR p_farmer_id = auth.uid()
    OR coalesce(private.cap_carteira_escrever(auth.uid()), false)
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Acesso negado: só o próprio farmer ou quem tem cap_carteira_escrever substitui recomendações'
      USING ERRCODE = '42501';
  END IF;

  -- 2) FORMATO.
  IF p_linhas IS NULL OR jsonb_typeof(p_linhas) <> 'array' THEN
    RAISE EXCEPTION 'p_linhas deve ser um array jsonb (recebido: %)',
      coalesce(jsonb_typeof(p_linhas), 'null') USING ERRCODE = 'FG002';
  END IF;

  v_total := jsonb_array_length(p_linhas);

  -- 3) LOTE VAZIO = RECUSA, não "expira tudo e deixa o farmer sem oferta".
  -- Zero recomendação quase sempre é dado faltando a montante (catálogo, scores,
  -- get_skus_margem_positiva), não "este farmer não tem o que oferecer" — mesmo
  -- raciocínio que farmer_association_rules_substituir aplica ao lote vazio.
  IF v_total = 0 THEN
    RAISE EXCEPTION 'lote vazio: as % recomendação(ões) pendentes deste farmer foram preservadas',
      (SELECT count(*) FROM public.farmer_recommendations
        WHERE farmer_id = p_farmer_id AND status = 'pendente')
      USING ERRCODE = 'FG003';
  END IF;

  -- Teto defensivo: a maior geração medida em prod tem ~1.000 linhas
  -- (3 cross + 2 up por cliente). 50k é ~50x isso — folga sem ficar ilimitado.
  IF v_total > 50000 THEN
    RAISE EXCEPTION 'lote de % linhas excede o teto de 50000', v_total USING ERRCODE = 'FG004';
  END IF;

  -- 4) SERIALIZAÇÃO por FARMER (não global: duas vendedoras recalculando ao mesmo
  -- tempo mexem em escopos disjuntos e não têm por que esperar uma pela outra).
  -- `xact` = o lock sai sozinho no commit/rollback.
  IF NOT pg_try_advisory_xact_lock(
        hashtext('farmer_recomendacoes_substituir'), hashtext(p_farmer_id::text)) THEN
    RAISE EXCEPTION 'outro recálculo deste farmer está em andamento — nada foi alterado'
      USING ERRCODE = 'FG005';
  END IF;

  -- 5) GUARD CAUSAL (compare-and-swap).
  -- O advisory lock acima só cobre a TRANSAÇÃO da RPC — ele não cobre a janela
  -- longa entre "o motor leu o snapshot" e "o motor chamou esta função". Sem este
  -- guard, dois recálculos sobrepostos terminam com o MAIS LENTO vencendo, e o
  -- mais lento é justamente o que leu o snapshot mais VELHO (money-path §10: o
  -- degradado terminar depois do saudável é o desfecho esperado, não o azar).
  -- Comparar geração vista × geração vigente não depende de relógio nenhum — nem
  -- do browser (que o cliente controla) nem do servidor.
  -- NULL casa NULL: primeira execução, e as 3.659 linhas legadas (run_id NULL).
  SELECT run_id INTO v_geracao_atual
  FROM public.farmer_recommendations
  WHERE farmer_id = p_farmer_id AND status = 'pendente'
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF v_geracao_atual IS DISTINCT FROM p_geracao_vista THEN
    RAISE EXCEPTION 'geração vigente mudou durante o cálculo (vista: %, atual: %) — nada foi alterado',
      coalesce(p_geracao_vista::text, 'nenhuma'), coalesce(v_geracao_atual::text, 'nenhuma')
      USING ERRCODE = 'FG006';
  END IF;

  -- 6) VALIDAÇÃO ANTES DE MEXER (nada é expirado se o lote tem lixo).
  SELECT count(*) INTO v_invalidas
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id        uuid,
    recommendation_type     text,
    product_id              uuid,
    affinity_score          numeric
  )
  WHERE r.customer_user_id IS NULL
     OR r.product_id IS NULL
     OR r.recommendation_type IS NULL
     OR r.recommendation_type NOT IN ('cross_sell', 'up_sell')
     -- Finitude nos TRÊS lados. `>= 0` sozinho NÃO sanea: medido em prod,
     -- `'NaN' >= 0` é TRUE e `'Infinity' >= 0` é TRUE (money-path §2). Escrito na
     -- forma positiva-negada de propósito — a variante `x <> 'NaN' IS NOT TRUE`
     -- lê igual e erra a precedência. `affinity_score` é a chave que ordena a
     -- oferta na tela: NaN aqui não dá número errado, DESLIGA a comparação.
     OR r.affinity_score IS NULL
     OR NOT (
          r.affinity_score >= 0
          AND r.affinity_score < 'Infinity'::numeric
          AND r.affinity_score <> 'NaN'::numeric
        );

  IF v_invalidas > 0 THEN
    RAISE EXCEPTION '% de % linha(s) inválidas (cliente/produto/tipo ausente, ou afinidade nula/negativa/NaN/Infinita) — nada foi expirado',
      v_invalidas, v_total USING ERRCODE = 'FG007';
  END IF;

  -- 7) A TROCA — os dois statements na MESMA transação.
  -- Só 'pendente' é tocado: linha com desfecho ('ofertado'/'aceito'/'rejeitado')
  -- é histórico e fica imutável. E é UPDATE, nunca DELETE.
  UPDATE public.farmer_recommendations
     SET status         = 'expirado',
         expired_at     = clock_timestamp(),
         expired_by_run = p_run_id,
         updated_at     = clock_timestamp()
   WHERE farmer_id = p_farmer_id
     AND status = 'pendente';
  GET DIAGNOSTICS v_expiradas = ROW_COUNT;

  INSERT INTO public.farmer_recommendations (
    farmer_id, customer_user_id, recommendation_type, product_id, current_product_id,
    p_ij, m_ij, lie, affinity_score, complexity_factor, cluster_volume_estimate,
    status, run_id
  )
  SELECT
    p_farmer_id, r.customer_user_id, r.recommendation_type, r.product_id, r.current_product_id,
    r.p_ij,
    -- m_ij e lie são DINHEIRO e saíram de cena no #1520 (o custo não chega mais ao
    -- browser). Fixados em NULL aqui, não copiados do payload: o cliente não tem
    -- como fabricá-los de volta.
    NULL, NULL,
    r.affinity_score, coalesce(r.complexity_factor, 1), coalesce(r.cluster_volume_estimate, 1),
    'pendente', p_run_id
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id        uuid,
    recommendation_type     text,
    product_id              uuid,
    current_product_id      uuid,
    p_ij                    numeric,
    affinity_score          numeric,
    complexity_factor       numeric,
    cluster_volume_estimate numeric
  );
  GET DIAGNOSTICS v_inseridas = ROW_COUNT;

  RETURN jsonb_build_object(
    'run_id',    p_run_id,
    'expiradas', v_expiradas,
    'inseridas', v_inseridas
  );
END;
$function$;

-- ============================================================
-- 6) RPC — bundles (mesmo contrato, mesma tabela-irmã)
-- ============================================================
CREATE OR REPLACE FUNCTION public.farmer_bundle_recomendacoes_substituir(
  p_farmer_id     uuid,
  p_run_id        uuid,
  p_geracao_vista uuid,
  p_linhas        jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total         integer;
  v_invalidas     integer;
  v_geracao_atual uuid;
  v_expiradas     integer;
  v_inseridas     integer;
BEGIN
  IF p_farmer_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'p_farmer_id e p_run_id são obrigatórios' USING ERRCODE = 'FG001';
  END IF;
  -- ⚠️ `IS NOT TRUE`, não `NOT (...)`. Numa sessão SEM JWT (pg_cron, psql) `auth.uid()`
  -- devolve NULL, então `p_farmer_id = auth.uid()` é NULL e a disjunção inteira vira
  -- NULL — e `IF NOT NULL THEN` NÃO dispara em PL/pgSQL. Medido em prod:
  --   NOT (false OR NULL OR false)          => NULL   (o RAISE nunca acontece)
  --   (false OR NULL OR false) IS NOT TRUE  => true   (barra, como se quer)
  -- Ou seja, a forma "óbvia" é um guard que não nega: ele devolve nulo. Fecha-se em
  -- TRUE explícito — só quem provou ter direito passa (money-path: fail-closed).
  IF (
    coalesce(auth.role(), '') = 'service_role'
    OR p_farmer_id = auth.uid()
    OR coalesce(private.cap_carteira_escrever(auth.uid()), false)
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Acesso negado: só o próprio farmer ou quem tem cap_carteira_escrever substitui recomendações'
      USING ERRCODE = '42501';
  END IF;

  IF p_linhas IS NULL OR jsonb_typeof(p_linhas) <> 'array' THEN
    RAISE EXCEPTION 'p_linhas deve ser um array jsonb (recebido: %)',
      coalesce(jsonb_typeof(p_linhas), 'null') USING ERRCODE = 'FG002';
  END IF;

  v_total := jsonb_array_length(p_linhas);

  IF v_total = 0 THEN
    RAISE EXCEPTION 'lote vazio: os % bundle(s) pendentes deste farmer foram preservados',
      (SELECT count(*) FROM public.farmer_bundle_recommendations
        WHERE farmer_id = p_farmer_id AND status = 'pendente')
      USING ERRCODE = 'FG003';
  END IF;

  IF v_total > 50000 THEN
    RAISE EXCEPTION 'lote de % linhas excede o teto de 50000', v_total USING ERRCODE = 'FG004';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
        hashtext('farmer_bundle_recomendacoes_substituir'), hashtext(p_farmer_id::text)) THEN
    RAISE EXCEPTION 'outro recálculo de bundles deste farmer está em andamento — nada foi alterado'
      USING ERRCODE = 'FG005';
  END IF;

  SELECT run_id INTO v_geracao_atual
  FROM public.farmer_bundle_recommendations
  WHERE farmer_id = p_farmer_id AND status = 'pendente'
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF v_geracao_atual IS DISTINCT FROM p_geracao_vista THEN
    RAISE EXCEPTION 'geração vigente de bundles mudou durante o cálculo (vista: %, atual: %) — nada foi alterado',
      coalesce(p_geracao_vista::text, 'nenhuma'), coalesce(v_geracao_atual::text, 'nenhuma')
      USING ERRCODE = 'FG006';
  END IF;

  SELECT count(*) INTO v_invalidas
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id uuid,
    bundle_products  jsonb,
    affinity_bundle  numeric
  )
  WHERE r.customer_user_id IS NULL
     OR r.bundle_products IS NULL
     OR jsonb_typeof(r.bundle_products) <> 'array'
     OR jsonb_array_length(r.bundle_products) = 0
     OR r.affinity_bundle IS NULL
     OR NOT (
          r.affinity_bundle >= 0
          AND r.affinity_bundle < 'Infinity'::numeric
          AND r.affinity_bundle <> 'NaN'::numeric
        );

  IF v_invalidas > 0 THEN
    RAISE EXCEPTION '% de % bundle(s) inválidos (cliente/produtos ausentes, ou afinidade nula/negativa/NaN/Infinita) — nada foi expirado',
      v_invalidas, v_total USING ERRCODE = 'FG007';
  END IF;

  UPDATE public.farmer_bundle_recommendations
     SET status         = 'expirado',
         expired_at     = clock_timestamp(),
         expired_by_run = p_run_id,
         updated_at     = clock_timestamp()
   WHERE farmer_id = p_farmer_id
     AND status = 'pendente';
  GET DIAGNOSTICS v_expiradas = ROW_COUNT;

  INSERT INTO public.farmer_bundle_recommendations (
    farmer_id, customer_user_id, bundle_products, support, confidence, lift,
    p_bundle, m_bundle, lie_bundle, affinity_bundle, complexity_factor,
    status, run_id
  )
  SELECT
    p_farmer_id, r.customer_user_id, r.bundle_products,
    r.support, r.confidence, r.lift, r.p_bundle,
    -- m_bundle/lie_bundle: dinheiro, fora de cena desde o #1520 (ver RPC irmã).
    NULL, NULL,
    r.affinity_bundle, coalesce(r.complexity_factor, 1),
    'pendente', p_run_id
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id  uuid,
    bundle_products   jsonb,
    support           numeric,
    confidence        numeric,
    lift              numeric,
    p_bundle          numeric,
    affinity_bundle   numeric,
    complexity_factor numeric
  );
  GET DIAGNOSTICS v_inseridas = ROW_COUNT;

  RETURN jsonb_build_object(
    'run_id',    p_run_id,
    'expiradas', v_expiradas,
    'inseridas', v_inseridas
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.farmer_recomendacoes_substituir(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.farmer_bundle_recomendacoes_substituir(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farmer_recomendacoes_substituir(uuid, uuid, uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.farmer_bundle_recomendacoes_substituir(uuid, uuid, uuid, jsonb) TO authenticated, service_role;
