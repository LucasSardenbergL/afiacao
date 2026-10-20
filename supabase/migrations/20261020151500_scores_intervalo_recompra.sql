-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Venda por cliente — Fase 1a: intervalo de recompra MEDIDO em farmer_client_scores
-- Spec: docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md §7 (1a)
-- Plano: docs/superpowers/plans/2026-10-20-venda-por-cliente.md (Task 3)
-- Prova: db/test-scores-intervalo-recompra.sh (PG17, executa as duas funções)
--
-- O DEFEITO. `avg_repurchase_interval` não era calculado por ninguém: o seed da edge gravava 0 e
-- 140 linhas legadas tinham 30 (6.334 com 0, medido 2026-10-20). A edge dava ~98 pontos de
-- frequência ao 30 e o cliente morto ia para "atenção"; a regra de positivação
-- `days > intervalo × 1,5` (recencia_critica) ficava inerte.
--
-- O QUE MUDA (3 objetos, nada de dado):
--   1. get_customer_sales_summary() ganha `intervalo_mediano_dias numeric` NO FIM: mediana dos gaps
--      entre dias DISTINTOS de pedido (histórico inteiro, mesmo universo de pedidos), NULL com < 3
--      dias. As 6 colunas anteriores são as mesmas — pré-voo na PROD: 0 divergências nos dois
--      sentidos (EXCEPT) em 1.229 linhas; 799 ganham intervalo (mediana 42d). Acrescentar OUT
--      exige DROP + CREATE (CREATE OR REPLACE não muda o tipo de retorno) → o ACL some junto e é
--      REEMITIDO abaixo nomeando PUBLIC, anon e authenticated (a prod só tem postgres, service_role
--      e sandbox_exec_*). Nenhum objeto depende dela (pg_depend, 2026-10-20).
--   2. apply_score_updates(jsonb,text) persiste `avg_repurchase_interval` por jsonb_exists, como
--      gross_margin_pct: chave presente grava (NULL inclusive); ausente preserva → edge anterior
--      segue funcionando. Mesma assinatura → CREATE OR REPLACE preserva o ACL.
--   3. farmer_client_scores.avg_repurchase_interval perde o DEFAULT 0 (o zero fabricado pela omissão).
--
-- ORDEM DE DEPLOY: esta migration ANTES da edge calculate-scores nova. Edge nova contra RPC velha
-- degrada para "intervalo não medido" (frequência sai da média), nunca para 0/30.
--
-- ⚠️ DROP FUNCTION = DDL destrutivo → fora do envelope da sessão: o founder cola no SQL Editor.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
BEGIN;

-- TRAVA, antes de ler: ALTER sem efeito em cada função que a PRE guarda (a volatilidade VIVA).
DO $trava$
BEGIN
  IF to_regprocedure('public.get_customer_sales_summary()') IS NOT NULL THEN
    ALTER FUNCTION public.get_customer_sales_summary() STABLE;
  END IF;
  IF to_regprocedure('public.apply_score_updates(jsonb,text)') IS NOT NULL THEN
    ALTER FUNCTION public.apply_score_updates(jsonb,text) VOLATILE;
  END IF;
END
$trava$;

-- PRE anti-deriva: md5 EXATO do corpo vivo ∈ {predecessor revisado (prod 2026-10-20), este}.
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.vivo, x.predecessor, x.este
      FROM (VALUES
        ('get_customer_sales_summary()',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
           WHERE p.oid = to_regprocedure('public.get_customer_sales_summary()')),
         'd156afc86ca2dec5e39681fa9a6e1289', '9fd92a3126e84282ed1e79fa7b15c2ff'),
        ('apply_score_updates(jsonb,text)',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
           WHERE p.oid = to_regprocedure('public.apply_score_updates(jsonb,text)')),
         'c26c270f9b51675863d67445160537b4', 'c8f29d280d8720c65e252df899759e41')
      ) AS x(alvo, vivo, predecessor, este)
  LOOP
    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) nao e o predecessor revisado nem este', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

-- 3. sem DEFAULT 0: omitir a chave não fabrica mais o zero.
ALTER TABLE public.farmer_client_scores ALTER COLUMN avg_repurchase_interval DROP DEFAULT;

-- 1. get_customer_sales_summary + intervalo_mediano_dias (no FIM).
DROP FUNCTION IF EXISTS public.get_customer_sales_summary();
CREATE FUNCTION public.get_customer_sales_summary()
 RETURNS TABLE(customer_user_id uuid, days_since_last_purchase integer, total_revenue numeric, revenue_180d numeric, item_count bigint, category_count bigint, intervalo_mediano_dias numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH itens AS (
    SELECT
      oi.customer_user_id,
      oi.unit_price,
      oi.quantity,
      oi.product_id,
      COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS dia
    FROM public.order_items oi
    JOIN public.sales_orders so ON so.id = oi.sales_order_id
    WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
      AND so.deleted_at IS NULL
      AND oi.customer_user_id IS NOT NULL
  ),
  gaps AS (
    SELECT d.customer_user_id,
           d.dia - lag(d.dia) OVER (PARTITION BY d.customer_user_id ORDER BY d.dia) AS gap
    FROM (SELECT DISTINCT customer_user_id, dia FROM itens WHERE dia IS NOT NULL) d
  ),
  intervalo AS (
    SELECT customer_user_id,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)::numeric AS intervalo_mediano_dias
    FROM gaps
    WHERE gap IS NOT NULL
    GROUP BY customer_user_id
    HAVING count(*) >= 2
  )
  SELECT
    i.customer_user_id,
    GREATEST(
      0,
      (now() AT TIME ZONE 'America/Sao_Paulo')::date - max(i.dia)
    )::int                                                                       AS days_since_last_purchase,
    COALESCE(sum(COALESCE(i.unit_price,0) * COALESCE(NULLIF(i.quantity,0),1)),0) AS total_revenue,
    COALESCE(sum(COALESCE(i.unit_price,0) * COALESCE(NULLIF(i.quantity,0),1))
             FILTER (WHERE i.dia BETWEEN (now() AT TIME ZONE 'America/Sao_Paulo')::date - 180
                                     AND (now() AT TIME ZONE 'America/Sao_Paulo')::date), 0) AS revenue_180d,
    count(*)                                                                     AS item_count,
    count(DISTINCT i.product_id)                                                 AS category_count,
    iv.intervalo_mediano_dias
  FROM itens i
  LEFT JOIN intervalo iv ON iv.customer_user_id = i.customer_user_id
  GROUP BY i.customer_user_id, iv.intervalo_mediano_dias;
$function$;

-- O DROP levou o ACL: a função nasce com EXECUTE para PUBLIC (+ default privileges do schema).
-- Reemitido nomeando as roles, igual ao da prod antes desta migration.
REVOKE ALL ON FUNCTION public.get_customer_sales_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_sales_summary() TO service_role;
DO $acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sandbox_exec_fzvklzpomgnyikkfkzai') THEN
    GRANT EXECUTE ON FUNCTION public.get_customer_sales_summary() TO sandbox_exec_fzvklzpomgnyikkfkzai;
  END IF;
END
$acl$;

-- 2. apply_score_updates persiste o intervalo (jsonb_exists).
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb, p_run_id text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
  v_total int;
  v_valid int;
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

  -- GUARD DE CONTRATO (full-update only): as 12 chaves CORE são obrigatórias em TODA linha.
  -- Aqui jsonb_to_recordset basta: ausente e null são AMBOS inválidos, então colapsá-los é correto.
  -- sales_history_status, gross_margin_pct, m_score, itens_com_custo, itens_sem_custo e
  -- avg_repurchase_interval NÃO entram (nuláveis por semântica).
  v_total := jsonb_array_length(p_updates);

  SELECT count(*) INTO v_valid
  FROM jsonb_to_recordset(p_updates) AS u(
    id                       uuid,
    health_score             numeric,
    health_class             text,
    churn_risk               numeric,
    priority_score           numeric,
    rf_score                 numeric,
    g_score                  numeric,
    days_since_last_purchase integer,
    avg_monthly_spend_180d   numeric,
    category_count           integer,
    calculated_at            timestamptz,
    updated_at               timestamptz
  )
  WHERE id                       IS NOT NULL
    AND health_score             IS NOT NULL
    AND health_class             IS NOT NULL
    AND churn_risk               IS NOT NULL
    AND priority_score           IS NOT NULL
    AND rf_score                 IS NOT NULL
    AND g_score                  IS NOT NULL
    AND days_since_last_purchase IS NOT NULL
    AND avg_monthly_spend_180d   IS NOT NULL
    AND category_count           IS NOT NULL
    AND calculated_at            IS NOT NULL
    AND updated_at               IS NOT NULL;

  IF v_valid <> v_total THEN
    RAISE EXCEPTION
      'apply_score_updates: contrato full-update violado — % de % elemento(s) com campo obrigatorio nulo/ausente (as 12 chaves CORE sao obrigatorias; jsonb_to_recordset nao faz COALESCE)',
      (v_total - v_valid), v_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- UPDATE-only por id (anti-ressurreição #971), base de vendas (#987) + sales_history_status (COALESCE)
  -- + cobertura de custo (itens_com_custo/itens_sem_custo, jsonb_exists como gross_margin_pct).
  UPDATE public.farmer_client_scores f SET
    health_score             = u.health_score,
    health_class             = u.health_class,
    churn_risk               = u.churn_risk,
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

-- PÓS: os corpos vivos são ESTES; a assinatura da RPC de vendas tem a coluna nova no fim; ACL fechado.
DO $pos$
DECLARE
  v_res text;
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure('public.get_customer_sales_summary()')) IS DISTINCT FROM '9fd92a3126e84282ed1e79fa7b15c2ff' THEN
    RAISE EXCEPTION 'POS FALHOU: get_customer_sales_summary nao e o corpo deste arquivo';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure('public.apply_score_updates(jsonb,text)')) IS DISTINCT FROM 'c8f29d280d8720c65e252df899759e41' THEN
    RAISE EXCEPTION 'POS FALHOU: apply_score_updates nao e o corpo deste arquivo';
  END IF;
  v_res := pg_get_function_result('public.get_customer_sales_summary()'::regprocedure);
  IF v_res IS DISTINCT FROM 'TABLE(customer_user_id uuid, days_since_last_purchase integer, total_revenue numeric, revenue_180d numeric, item_count bigint, category_count bigint, intervalo_mediano_dias numeric)' THEN
    RAISE EXCEPTION 'POS FALHOU: retorno de get_customer_sales_summary = %', v_res;
  END IF;
  IF has_function_privilege('anon', 'public.get_customer_sales_summary()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_customer_sales_summary()', 'EXECUTE')
     OR (SELECT p.proacl IS NULL FROM pg_proc p WHERE p.oid = 'public.get_customer_sales_summary()'::regprocedure)
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid = 'public.get_customer_sales_summary()'::regprocedure AND a.grantee = 0) THEN
    RAISE EXCEPTION 'POS FALHOU: get_customer_sales_summary executavel por PUBLIC/anon/authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.get_customer_sales_summary()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: service_role perdeu EXECUTE em get_customer_sales_summary (a edge para)';
  END IF;
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'farmer_client_scores'
         AND column_name = 'avg_repurchase_interval') IS NOT NULL THEN
    RAISE EXCEPTION 'POS FALHOU: avg_repurchase_interval ainda tem DEFAULT';
  END IF;
END
$pos$;

-- PostgREST: a coluna nova da RPC só aparece para a edge depois do reload do cache de schema.
NOTIFY pgrst, 'reload schema';

COMMIT;
