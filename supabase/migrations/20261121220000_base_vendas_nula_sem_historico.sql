-- ============================================================================================================
-- days_since_last_purchase / avg_monthly_spend_180d NULL para quem não tem venda (sem o 999 / R$ 0 sentinela)
-- Migration MANUAL (custom não auto-aplica no Lovable): aplicar pelo envelope (`bun run db:aplicar`), que
-- fornece a transação.
--
-- O NÚMERO FABRICADO: a edge `calculate-scores` gravava 999 dias e R$ 0 de gasto para os 15.766 clientes
-- `sem_historico` (prod, psql-ro, 2026-11-21 21:36 UTC: 15.766/15.766 com 999 e 0) — nenhum deles tem linha na
-- RPC de vendas, então os dois números eram puro sentinela de `deriveSalesBase`. A v1.8 passa a gravar NULL
-- ("não medido") quando o cliente não tem linha na RPC, e esta migration é o que permite gravar:
--
--  apply_score_updates(jsonb,text): `days_since_last_purchase` e `avg_monthly_spend_180d` saem das chaves CORE
--  do recordset (onde NULL era violação; ficam 8) e ganham guard PRÓPRIO por `jsonb_exists`, idêntico ao do
--  priority_score/churn_risk: chave AUSENTE (qualquer das duas) continua `check_violation` e derruba o lote;
--  NULL EXPLÍCITO é aceito e gravado — UPDATE direto, sem COALESCE (o 999 velho não pode sobreviver a um NULL
--  deliberado). Fencing (55000/22004), `p_run_id DEFAULT NULL`, os guards de priority/churn, `category_count`
--  CORE, `avg_repurchase_interval`, cobertura de custo: inalterados.
--
--  O ZERO e o 999 MEDIDOS ficam: os 850 stale com gasto 0 têm pedido válido e nenhuma venda na janela de 180d
--  (min 183 dias), e os 2 stale com 999 compraram em 2024-02-26 — 999 dias reais. A edge decide pela FONTE
--  (linha ausente na RPC), nunca pelo valor.
--
--  Trigger de fila de visita NÃO é recriado: `enqueue_visit_score_recalc_from_client_score` (md5 fbed0943…)
--  observa só priority_score/churn_risk/expansion_score/signal_modifiers, e nenhum outro trigger de
--  farmer_client_scores olha estas colunas — a transição 999→NULL / 0→NULL não enfileira nada (o dreno é
--  500/noite; lição do #4032). Provado em db/test-base-vendas-nula-sem-historico.sh.
--  Colunas: já nullable em prod (information_schema, 2026-11-21). O DEFAULT 0 delas SAI (challenge Codex de
--  revisão, 2026-11-21): `reconcile_score_owner_from_carteira` insere a linha só com (customer_user_id,
--  farmer_id), e o default fabricava "0 dias = comprou hoje" e "gasto R$ 0" até o próximo run saudável. Sem
--  default a linha nova nasce NULL ("ainda não medido"). A edge segue mandando as chaves SEMPRE.
--
-- TRAVA → PRE (md5(prosrc) ∈ {predecessor de prod, este}) → REPLACE → PÓS (corpo, atributos, ACL).
-- Predecessor medido em prod (psql-ro, 2026-11-21 21:36 UTC) = o corpo de 20261121150000:
--   apply_score_updates  md5(prosrc) 3507b641249de3ce80f714e6b39c7381 · functiondef 8939ad0943863bb76bd0c99ec0e82a15
-- CREATE OR REPLACE PRESERVA o ACL; o REVOKE abaixo nomeia as roles só para fechar a porta se alguém a tiver
-- aberto à mão.
-- Prova: db/test-base-vendas-nula-sem-historico.sh (PG17, idempotência, lote misto 23514, fila, falsificação).
-- ============================================================================================================

SET LOCAL lock_timeout = '5s';

-- ── TRAVA: ALTER sem efeito (atributo VIVO), ANTES de ler o corpo ───────────────────────────────────────────
DO $trava$
BEGIN
  IF to_regprocedure('public.apply_score_updates(jsonb, text)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: public.apply_score_updates(jsonb, text) não existe — o predecessor de prod é obrigatório';
  END IF;
  ALTER FUNCTION public.apply_score_updates(jsonb, text) VOLATILE;
END
$trava$;

-- ── PRE: o corpo vivo é o predecessor revisado ou já é este ───────────────────────────────────────────────
DO $pre$
DECLARE
  v_apply text;
BEGIN
  SELECT md5(p.prosrc) INTO v_apply FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.apply_score_updates(jsonb, text)'::regprocedure;
  IF v_apply IS DISTINCT FROM '3507b641249de3ce80f714e6b39c7381' AND v_apply IS DISTINCT FROM '743cdb8c4ef2b488c28a78a6c56353c0' THEN
    RAISE EXCEPTION 'PRE FALHOU: apply_score_updates vivo tem md5 % (esperado o predecessor 3507b641249de3ce80f714e6b39c7381 ou este 743cdb8c4ef2b488c28a78a6c56353c0) — reler o corpo de prod antes de reaplicar',
      v_apply;
  END IF;
END
$pre$;

-- ── apply_score_updates ─────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb, p_run_id text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
  v_total int;
  v_valid int;
  v_sem_prioridade int;
  v_sem_churn int;
  v_sem_base  int;
  v_dono  text;
  v_status text;
BEGIN
  -- ── FENCING DO LEASE ─────────────────────────────────────────────────────────────────────────
  -- Primeira coisa do corpo, ANTES do guard de contrato e do UPDATE: quem não é dono não paga nem
  -- o custo de validar o payload, e o lock é tomado antes de qualquer trabalho.
  IF p_run_id IS NOT NULL THEN
    IF btrim(p_run_id) = '' THEN
      RAISE EXCEPTION 'apply_score_updates: p_run_id vazio (use NULL para chamar sem fencing, nunca string vazia)'
        USING ERRCODE = '22004';
    END IF;

    -- FOR SHARE: trava a linha de lease até o COMMIT deste chunk. O claim rival bloqueia até lá, de
    -- modo que "sou dono" e "escrevo" ficam atômicos. Sem isto a checagem seria decorativa.
    PERFORM 1
       FROM public.sync_state
      WHERE entity_type = 'calculate_scores'
        AND account     = 'global'
        AND status      = 'syncing'
        AND (metadata->>'run_id') = p_run_id
      FOR SHARE;

    IF NOT FOUND THEN
      -- Diagnóstico: quem é o dono corrente e em que estado. Só ids de run (crypto.randomUUID da
      -- edge) e o status do lease — domínio fechado, sem dado de cliente.
      SELECT s.metadata->>'run_id', s.status INTO v_dono, v_status
        FROM public.sync_state s
       WHERE s.entity_type = 'calculate_scores' AND s.account = 'global';
      RAISE EXCEPTION
        'apply_score_updates: run % nao e dono do lease (dono=% status=%) — escrita recusada para nao restaurar snapshot velho',
        p_run_id, coalesce(v_dono, '<sem lease>'), coalesce(v_status, '<sem linha>')
        USING ERRCODE = '55000';
    END IF;
  END IF;
  -- ── fim do fencing ───────────────────────────────────────────────────────────────────────────

  -- GUARD DE CONTRATO (full-update only): as 8 chaves CORE são obrigatórias e NÃO-NULAS em TODA linha.
  -- Aqui jsonb_to_recordset basta: ausente e null são AMBOS inválidos, então colapsá-los é correto.
  -- sales_history_status, gross_margin_pct, m_score, itens_com_custo, itens_sem_custo e
  -- avg_repurchase_interval NÃO entram (nuláveis por semântica). priority_score também saiu daqui
  -- (migration 20261120210000): NULL é o valor CERTO de quem nunca comprou — o guard dele é o de baixo.
  -- churn_risk saiu pelo mesmo motivo (migration 20261121150000): quem nunca comprou não tem o que perder.
  -- days_since_last_purchase e avg_monthly_spend_180d saíram também (migration 20261121220000): sem linha na
  -- RPC de vendas eles são NÃO MEDIDOS (NULL), não o 999/R$0 sentinela — guard próprio logo abaixo.
  v_total := jsonb_array_length(p_updates);

  SELECT count(*) INTO v_valid
  FROM jsonb_to_recordset(p_updates) AS u(
    id                       uuid,
    health_score             numeric,
    health_class             text,
    rf_score                 numeric,
    g_score                  numeric,
    category_count           integer,
    calculated_at            timestamptz,
    updated_at               timestamptz
  )
  WHERE id                       IS NOT NULL
    AND health_score             IS NOT NULL
    AND health_class             IS NOT NULL
    AND rf_score                 IS NOT NULL
    AND g_score                  IS NOT NULL
    AND category_count           IS NOT NULL
    AND calculated_at            IS NOT NULL
    AND updated_at               IS NOT NULL;

  IF v_valid <> v_total THEN
    RAISE EXCEPTION
      'apply_score_updates: contrato full-update violado — % de % elemento(s) com campo obrigatorio nulo/ausente (as 8 chaves CORE sao obrigatorias; jsonb_to_recordset nao faz COALESCE)',
      (v_total - v_valid), v_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- priority_score: a CHAVE é obrigatória, o VALOR pode ser NULL. jsonb_exists distingue os dois — o
  -- recordset acima não distinguiria (ausente e null viram o mesmo NULL). Chave ausente = writer que não
  -- sabe da regra; aceitá-la gravaria NULL por omissão e apagaria a prioridade de um comprador.
  SELECT count(*) INTO v_sem_prioridade
  FROM jsonb_array_elements(p_updates) AS e(elem)
  WHERE NOT jsonb_exists(e.elem, 'priority_score');

  IF v_sem_prioridade > 0 THEN
    RAISE EXCEPTION
      'apply_score_updates: contrato full-update violado — % de % elemento(s) sem a chave priority_score (null explicito e aceito; chave ausente nao)',
      v_sem_prioridade, v_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- churn_risk: mesmo contrato do priority_score — CHAVE obrigatória, VALOR pode ser NULL ("sem histórico,
  -- risco de perda não se aplica"). Chave ausente = writer que não sabe da regra; aceitá-la gravaria NULL por
  -- omissão e apagaria o risco de um comprador.
  SELECT count(*) INTO v_sem_churn
  FROM jsonb_array_elements(p_updates) AS e(elem)
  WHERE NOT jsonb_exists(e.elem, 'churn_risk');

  IF v_sem_churn > 0 THEN
    RAISE EXCEPTION
      'apply_score_updates: contrato full-update violado — % de % elemento(s) sem a chave churn_risk (null explicito e aceito; chave ausente nao)',
      v_sem_churn, v_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- days_since_last_purchase e avg_monthly_spend_180d: mesmo contrato — CHAVE obrigatória (as DUAS), VALOR pode
  -- ser NULL ("não medido": cliente sem linha na RPC de vendas). Chave ausente = writer que não sabe da regra;
  -- aceitá-la gravaria NULL por omissão e apagaria a recência/gasto medidos de um comprador.
  SELECT count(*) INTO v_sem_base
  FROM jsonb_array_elements(p_updates) AS e(elem)
  WHERE NOT jsonb_exists(e.elem, 'days_since_last_purchase')
     OR NOT jsonb_exists(e.elem, 'avg_monthly_spend_180d');

  IF v_sem_base > 0 THEN
    RAISE EXCEPTION
      'apply_score_updates: contrato full-update violado — % de % elemento(s) sem a chave days_since_last_purchase/avg_monthly_spend_180d (null explicito e aceito; chave ausente nao)',
      v_sem_base, v_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- UPDATE-only por id (anti-ressurreição #971), base de vendas (#987) + sales_history_status (COALESCE)
  -- + cobertura de custo (itens_com_custo/itens_sem_custo, jsonb_exists como gross_margin_pct).
  UPDATE public.farmer_client_scores f SET
    health_score             = u.health_score,
    health_class             = u.health_class,
    -- SEM COALESCE (migration 20261121150000): a chave está garantida pelo guard acima, então NULL aqui é
    -- deliberado ("sem histórico, risco de perda não se aplica") e tem de sobrescrever o 100 velho.
    churn_risk               = u.churn_risk,
    -- SEM COALESCE: a chave está garantida pelo guard acima, então NULL aqui é deliberado ("sem histórico,
    -- prioridade não se aplica") e tem de sobrescrever o número velho.
    priority_score           = u.priority_score,
    rf_score                 = u.rf_score,
    m_score                  = CASE WHEN u.tem_m_score          THEN u.m_score          ELSE f.m_score          END,
    g_score                  = u.g_score,
    gross_margin_pct         = CASE WHEN u.tem_gross_margin_pct THEN u.gross_margin_pct ELSE f.gross_margin_pct END,
    itens_com_custo          = CASE WHEN u.tem_itens_com_custo  THEN u.itens_com_custo  ELSE f.itens_com_custo  END,
    itens_sem_custo          = CASE WHEN u.tem_itens_sem_custo  THEN u.itens_sem_custo  ELSE f.itens_sem_custo  END,
    -- Intervalo de recompra medido (Venda por cliente, 1a): chave presente grava (NULL inclusive —
    -- "< 3 dias de pedido", nunca 0/30); ausente (edge anterior) preserva.
    avg_repurchase_interval  = CASE WHEN u.tem_avg_repurchase_interval THEN u.avg_repurchase_interval ELSE f.avg_repurchase_interval END,
    -- SEM COALESCE (migration 20261121220000): as chaves estão garantidas pelo guard acima, então NULL aqui é
    -- deliberado ("não medido") e tem de sobrescrever o 999/R$0 sentinela velho.
    days_since_last_purchase = u.days_since_last_purchase,
    avg_monthly_spend_180d   = u.avg_monthly_spend_180d,
    category_count           = u.category_count,
    sales_history_status     = COALESCE(u.sales_history_status, f.sales_history_status),
    calculated_at            = u.calculated_at,
    updated_at               = u.updated_at
  FROM (
    SELECT
      (e.elem->>'id')::uuid                          AS id,
      (e.elem->>'health_score')::numeric             AS health_score,
      (e.elem->>'health_class')                      AS health_class,
      (e.elem->>'churn_risk')::numeric               AS churn_risk,
      (e.elem->>'priority_score')::numeric           AS priority_score,
      (e.elem->>'rf_score')::numeric                 AS rf_score,
      (e.elem->>'m_score')::numeric                  AS m_score,
      (e.elem->>'g_score')::numeric                  AS g_score,
      (e.elem->>'gross_margin_pct')::numeric         AS gross_margin_pct,
      (e.elem->>'itens_com_custo')::bigint           AS itens_com_custo,
      (e.elem->>'itens_sem_custo')::bigint           AS itens_sem_custo,
      (e.elem->>'avg_repurchase_interval')::numeric  AS avg_repurchase_interval,
      (e.elem->>'days_since_last_purchase')::integer AS days_since_last_purchase,
      (e.elem->>'avg_monthly_spend_180d')::numeric   AS avg_monthly_spend_180d,
      (e.elem->>'category_count')::integer           AS category_count,
      (e.elem->>'sales_history_status')              AS sales_history_status,
      (e.elem->>'calculated_at')::timestamptz        AS calculated_at,
      (e.elem->>'updated_at')::timestamptz           AS updated_at,
      -- jsonb_exists(), e não o operador ?, para não depender de como o parser trata ? em plpgsql.
      jsonb_exists(e.elem, 'm_score')                AS tem_m_score,
      jsonb_exists(e.elem, 'gross_margin_pct')       AS tem_gross_margin_pct,
      jsonb_exists(e.elem, 'itens_com_custo')        AS tem_itens_com_custo,
      jsonb_exists(e.elem, 'itens_sem_custo')        AS tem_itens_sem_custo,
      jsonb_exists(e.elem, 'avg_repurchase_interval') AS tem_avg_repurchase_interval
    FROM jsonb_array_elements(p_updates) AS e(elem)
  ) u
  WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $function$;

REVOKE ALL ON FUNCTION public.apply_score_updates(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_score_updates(jsonb, text) TO service_role;

-- ── DEFAULT 0 sai das duas colunas (insert esparso nasce NULL, não "comprou hoje / R$ 0") ─────────────────────
ALTER TABLE public.farmer_client_scores
  ALTER COLUMN days_since_last_purchase DROP DEFAULT,
  ALTER COLUMN avg_monthly_spend_180d   DROP DEFAULT;

-- ── PÓS: corpo (md5 exato), atributos, ACL, defaults, trigger de fila intacto ─────────────────────────────────────────
DO $post$
DECLARE
  v record;
  fa constant text := 'public.apply_score_updates(jsonb, text)';
  ft constant text := 'public.enqueue_visit_score_recalc_from_client_score()';
BEGIN
  SELECT md5(p.prosrc) AS md5, p.prosecdef, p.provolatile, p.proconfig,
         pg_get_function_arguments(p.oid) AS args,
         (SELECT count(*) FROM pg_catalog.pg_proc o WHERE o.pronamespace = p.pronamespace AND o.proname = p.proname) AS sobrecargas
    INTO v FROM pg_catalog.pg_proc p WHERE p.oid = fa::regprocedure;
  IF v.md5 IS DISTINCT FROM '743cdb8c4ef2b488c28a78a6c56353c0' THEN
    RAISE EXCEPTION 'PÓS FALHOU: % ficou com md5 % (esperado 743cdb8c4ef2b488c28a78a6c56353c0)', fa, v.md5;
  END IF;
  IF v.prosecdef OR v.provolatile <> 'v' OR v.proconfig IS DISTINCT FROM ARRAY['search_path=public']
     OR v.args IS DISTINCT FROM 'p_updates jsonb, p_run_id text DEFAULT NULL::text' OR v.sobrecargas <> 1 THEN
    RAISE EXCEPTION 'PÓS FALHOU: % mudou de forma (secdef %, vol %, config %, args %, sobrecargas %)',
      fa, v.prosecdef, v.provolatile, v.proconfig, v.args, v.sobrecargas;
  END IF;
  IF has_function_privilege('public', fa, 'EXECUTE')
     OR has_function_privilege('anon', fa, 'EXECUTE')
     OR has_function_privilege('authenticated', fa, 'EXECUTE')
     OR NOT has_function_privilege('service_role', fa, 'EXECUTE') THEN
    RAISE EXCEPTION 'PÓS FALHOU: ACL de % (PUBLIC/anon/authenticated não executam; service_role executa)', fa;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'farmer_client_scores'
                AND column_name IN ('days_since_last_purchase', 'avg_monthly_spend_180d')
                AND column_default IS NOT NULL) THEN
    RAISE EXCEPTION 'PÓS FALHOU: days_since_last_purchase/avg_monthly_spend_180d ainda têm DEFAULT — insert esparso refabricaria 0';
  END IF;

  -- O trigger de fila segue o de 20261121150000 (não observa dias/gasto): se alguém o trocou, esta migration
  -- não prova mais que a transição não enfileira.
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = ft::regprocedure)
     IS DISTINCT FROM 'fbed094342f63ec8313a349755c68a72' THEN
    RAISE EXCEPTION 'PÓS FALHOU: % não é o corpo fbed094342f63ec8313a349755c68a72 — reavaliar a fila antes', ft;
  END IF;

  RAISE NOTICE 'VALIDADO 20261121220000: apply_score_updates aceita dias/gasto NULL explicitos (chave ausente segue 23514), colunas sem DEFAULT';
END
$post$;
