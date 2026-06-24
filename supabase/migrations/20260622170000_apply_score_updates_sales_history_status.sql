-- ============================================================================
-- apply_score_updates v4 (#987-guard + sales_history_status). Money-path · anti-ressurreição.
-- Estende a v3/guard (20260622160000: UPDATE-only por id, guard full-update das 13 chaves) com a
-- 14ª chave sales_history_status — OPCIONAL e COALESCE (preserva-se-ausente) → deploy bidirecional-seguro:
--   edge ANTIGO (não envia) + RPC nova  → COALESCE preserva o valor atual (NÃO apaga em massa)
--   edge novo + RPC ANTIGA              → chave ignorada (sem erro); status só persiste pós-apply
--   edge novo + RPC nova                → atualiza
-- O guard das 13 é PRESERVADO intacto (sales_history_status fica FORA dele): o edge antigo
-- continua válido. Pré-flight pg_get_functiondef da prod antes do apply (a última recriação vence).
--
-- ⚠️ ORDEM DE APLICAÇÃO / REPLAY (Lovable SQL Editor e DR): timestamp DELIBERADAMENTE posterior a
-- 20260622160000_apply_score_updates_guard_full_update.sql (v3, JÁ em prod e em origin/main). Como
-- "o último CREATE OR REPLACE vence", num replay ordenado (rebuild do snapshot) ESTA recria a função
-- por ÚLTIMO, por cima do guard — senão o guard (com timestamp maior) sobrescreveria e DERRUBARIA o
-- sales_history_status do SET. A coluna vem de 20260621120000_sales_history_status_coluna.sql (timestamp
-- anterior → existe quando o COALESCE a referencia). NUNCA reaplicar a v3 depois desta (mataria a 14ª chave).
--
-- SEGURANÇA: idêntica ao #971/#987 — SECURITY INVOKER (menor privilégio) + REVOKE de PUBLIC/anon/
-- authenticated + GRANT EXECUTE só a service_role. Chamada SÓ pelo edge via service_role.
--
-- Provado em PG17 + falsificação: prove-sql-money-path (db/test-apply-score-updates-shs.sh).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_count int;
  v_total int;
  v_valid int;
BEGIN
  -- ── GUARD DE CONTRATO (full-update only): as 13 chaves CORE são obrigatórias em TODA linha ──
  -- sales_history_status NÃO entra aqui (é opcional/COALESCE) → edge antigo segue válido.
  v_total := jsonb_array_length(p_updates);

  SELECT count(*) INTO v_valid
  FROM jsonb_to_recordset(p_updates) AS u(
    id                       uuid,
    health_score             numeric,
    health_class             text,
    churn_risk               numeric,
    priority_score           numeric,
    rf_score                 numeric,
    m_score                  numeric,
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
    AND m_score                  IS NOT NULL
    AND g_score                  IS NOT NULL
    AND days_since_last_purchase IS NOT NULL
    AND avg_monthly_spend_180d   IS NOT NULL
    AND category_count           IS NOT NULL
    AND calculated_at            IS NOT NULL
    AND updated_at               IS NOT NULL;

  IF v_valid <> v_total THEN
    RAISE EXCEPTION
      'apply_score_updates: contrato full-update violado — % de % elemento(s) com campo obrigatorio nulo/ausente (as 13 chaves sao obrigatorias; jsonb_to_recordset nao faz COALESCE)',
      (v_total - v_valid), v_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── UPDATE-only por id (anti-ressurreição #971), base de vendas (#987) + sales_history_status (COALESCE) ──
  UPDATE public.farmer_client_scores f SET
    health_score             = u.health_score,
    health_class             = u.health_class,
    churn_risk               = u.churn_risk,
    priority_score           = u.priority_score,
    rf_score                 = u.rf_score,
    m_score                  = u.m_score,
    g_score                  = u.g_score,
    days_since_last_purchase = u.days_since_last_purchase,
    avg_monthly_spend_180d   = u.avg_monthly_spend_180d,
    category_count           = u.category_count,
    sales_history_status     = COALESCE(u.sales_history_status, f.sales_history_status),
    calculated_at            = u.calculated_at,
    updated_at               = u.updated_at
  FROM jsonb_to_recordset(p_updates) AS u(
    id                       uuid,
    health_score             numeric,
    health_class             text,
    churn_risk               numeric,
    priority_score           numeric,
    rf_score                 numeric,
    m_score                  numeric,
    g_score                  numeric,
    days_since_last_purchase integer,
    avg_monthly_spend_180d   numeric,
    category_count           integer,
    sales_history_status     text,
    calculated_at            timestamptz,
    updated_at               timestamptz
  )
  WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL    ON FUNCTION public.apply_score_updates(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_score_updates(jsonb) TO service_role;

-- ============================================================
-- Validação (cole no SQL Editor; confira: existe=1, tem_guard=t, tem_base=t, tem_shs=t,
-- exec_service=t, exec_auth=f, exec_anon=f)
-- ============================================================
SELECT 'apply_score_updates v4 (sales_history_status) OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname = 'apply_score_updates')                         AS existe,
  pg_get_functiondef('public.apply_score_updates(jsonb)'::regprocedure)
    LIKE '%contrato full-update violado%'                                                       AS tem_guard,
  pg_get_functiondef('public.apply_score_updates(jsonb)'::regprocedure)
    LIKE '%days_since_last_purchase = u.days_since_last_purchase%'                              AS tem_base,
  pg_get_functiondef('public.apply_score_updates(jsonb)'::regprocedure)
    LIKE '%sales_history_status     = COALESCE(u.sales_history_status, f.sales_history_status)%' AS tem_shs,
  has_function_privilege('service_role',  'public.apply_score_updates(jsonb)', 'EXECUTE')       AS exec_service,
  has_function_privilege('authenticated', 'public.apply_score_updates(jsonb)', 'EXECUTE')       AS exec_auth,
  has_function_privilege('anon',          'public.apply_score_updates(jsonb)', 'EXECUTE')       AS exec_anon;
