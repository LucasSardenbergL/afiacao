-- Predecessores VERBATIM da PROD (pg_get_functiondef, 2026-10-20) de
-- supabase/migrations/20261020151500_scores_intervalo_recompra.sql — a PRE da migration exige estes md5
-- (get_customer_sales_summary d156afc8…, apply_score_updates c26c270f…). Usado por
-- db/test-scores-intervalo-recompra.sh.
CREATE OR REPLACE FUNCTION public.get_customer_sales_summary()
 RETURNS TABLE(customer_user_id uuid, days_since_last_purchase integer, total_revenue numeric, revenue_180d numeric, item_count bigint, category_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    oi.customer_user_id,
    GREATEST(
      0,
      (now() AT TIME ZONE 'America/Sao_Paulo')::date
        - max(COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date))
    )::int                                                                       AS days_since_last_purchase,
    COALESCE(sum(COALESCE(oi.unit_price,0) * COALESCE(NULLIF(oi.quantity,0),1)),0) AS total_revenue,
    COALESCE(sum(COALESCE(oi.unit_price,0) * COALESCE(NULLIF(oi.quantity,0),1))
             FILTER (WHERE COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date)
                          BETWEEN (now() AT TIME ZONE 'America/Sao_Paulo')::date - 180
                              AND (now() AT TIME ZONE 'America/Sao_Paulo')::date), 0) AS revenue_180d,
    count(*)                                                                     AS item_count,
    count(DISTINCT oi.product_id)                                                AS category_count
  FROM public.order_items oi
  JOIN public.sales_orders so ON so.id = oi.sales_order_id
  WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
    AND so.deleted_at IS NULL
    AND oi.customer_user_id IS NOT NULL
  GROUP BY oi.customer_user_id;
$function$;

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
  -- sales_history_status, gross_margin_pct, m_score, itens_com_custo e itens_sem_custo NÃO entram
  -- (nuláveis por semântica).
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
      jsonb_exists(e.elem, 'itens_sem_custo')        AS tem_itens_sem_custo
    FROM jsonb_array_elements(p_updates) AS e(elem)
  ) u
  WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $function$;
