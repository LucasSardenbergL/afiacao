-- 20260525160000_carteira_saude_rpc.sql
-- Sub-PR E: RPC de saúde/observabilidade da carteira (semáforo no /admin/analytics-sync).
-- SECURITY DEFINER (lê cron.* que staff não acessa); gate master/staff. Read-only.

CREATE OR REPLACE FUNCTION public.get_carteira_saude()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  result jsonb;
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  IF NOT (has_role(uid, 'master'::app_role) OR has_role(uid, 'employee'::app_role)) THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
    -- 1. Saúde dos 4 crons da carteira (último run via cron.job × job_run_details)
    'crons', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'jobname', j.jobname,
        'last_status', r.status,
        'last_run_at', r.start_time,
        'age_hours', CASE WHEN r.start_time IS NULL THEN NULL
                          ELSE round(extract(epoch FROM (now() - r.start_time)) / 3600.0, 1) END,
        'last_error', CASE WHEN lower(coalesce(r.status, '')) IN ('failed','failure','error')
                           THEN r.return_message ELSE NULL END
      ) ORDER BY j.jobname)
      FROM cron.job j
      LEFT JOIN LATERAL (
        SELECT d.status, d.start_time, d.return_message
        FROM cron.job_run_details d
        WHERE d.jobid = j.jobid
        ORDER BY d.start_time DESC NULLS LAST
        LIMIT 1
      ) r ON true
      WHERE j.jobname IN (
        'carteira-rebuild-nightly',
        'scoring-recalc-batch-nightly',
        'visit-score-recalc-batch-nightly',
        'carteira-positivacao-snapshot-mensal'
      )
    ), '[]'::jsonb),

    -- 2. Frescor do sync da carteira
    'sync', (
      SELECT jsonb_build_object(
        'max_last_synced_at', max(last_synced_at),
        'age_hours', CASE WHEN max(last_synced_at) IS NULL THEN NULL
                          ELSE round(extract(epoch FROM (now() - max(last_synced_at))) / 3600.0, 1) END,
        'stale_count', count(*) FILTER (
          WHERE last_synced_at IS NULL OR last_synced_at < now() - interval '48 hours')
      )
      FROM public.carteira_assignments
    ),

    -- 3. Cobertura de score: clientes da carteira COM linha de score (EXISTS evita falso-alarme de órfãos)
    'score_coverage', jsonb_build_object(
      'carteira', (SELECT count(*) FROM public.carteira_assignments),
      'fcs_clientes', (
        SELECT count(*) FROM public.carteira_assignments ca
        WHERE EXISTS (SELECT 1 FROM public.farmer_client_scores f WHERE f.customer_user_id = ca.customer_user_id)
      ),
      'cvs_clientes', (
        SELECT count(*) FROM public.carteira_assignments ca
        WHERE EXISTS (SELECT 1 FROM public.customer_visit_scores c WHERE c.customer_user_id = ca.customer_user_id)
      )
    )
  ) INTO result;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_carteira_saude() TO authenticated;

SELECT 'BLOCO CARTEIRA SAUDE OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname = 'get_carteira_saude') AS rpc;
