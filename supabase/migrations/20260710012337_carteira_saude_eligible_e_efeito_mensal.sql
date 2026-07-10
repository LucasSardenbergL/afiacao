-- ============================================================
-- get_carteira_saude() v2 — conserta 2 falsos alarmes do semáforo
-- (diagnóstico 2026-07-09, painel /admin/analytics-sync)
--
-- (1) score_coverage/sync: o denominador contava a carteira INTEIRA
--     (6.909), mas 2.107 assignments são eligible=false (clones Colacor SC,
--     fornecedores flaggeados, órfãos) — escondidos da tela POR DESIGN do
--     carteira-rebuild e nunca processados pelos motores de score.
--     Resultado: "Cobertura de score incompleta" vermelho PERMANENTE mesmo
--     com 100% dos elegíveis cobertos (4.802/4.802 farmer no diagnóstico).
--     Agora os 3 blocos medem só a carteira operacional (eligible=true) —
--     o mesmo recorte que a tela mostra.
--
-- (2) crons: o purge-cron-job-run-details (diário 04:00, retenção ~8d)
--     expurga o run de um cron MENSAL na maior parte do mês → o painel
--     mentia "nunca rodou" para carteira-positivacao-snapshot-mensal
--     (rodou 2026-07-01 08:00; efeito: 20.726 linhas no snapshot).
--     Fallback pro EFEITO: quando job_run_details não tem linha, o cron
--     mensal reporta max(created_at) de carteira_positivacao_snapshot
--     como last_run_at (status 'succeeded' — o efeito é a prova).
--     O front passa a alertar snapshot atrasado (>35d) — antes era surdo.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_carteira_saude()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  result jsonb;
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  IF NOT (has_role(uid, 'master'::app_role) OR has_role(uid, 'employee'::app_role)) THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
    'crons', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'jobname', j.jobname,
        'last_status', COALESCE(r.status,
                                CASE WHEN ef.effect_at IS NOT NULL THEN 'succeeded' END),
        'last_run_at', COALESCE(r.start_time, ef.effect_at),
        'age_hours', CASE WHEN COALESCE(r.start_time, ef.effect_at) IS NULL THEN NULL
                          ELSE round(extract(epoch FROM (now() - COALESCE(r.start_time, ef.effect_at))) / 3600.0, 1) END,
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
      LEFT JOIN LATERAL (
        -- Fallback por EFEITO (só o cron mensal): o purge diário de
        -- job_run_details apaga o run mensal na maior parte do mês; o
        -- snapshot gravado é a verdade de que ele rodou.
        SELECT max(s.created_at) AS effect_at
        FROM public.carteira_positivacao_snapshot s
        WHERE j.jobname = 'carteira-positivacao-snapshot-mensal'
      ) ef ON true
      WHERE j.jobname IN (
        'carteira-rebuild-nightly',
        'scoring-recalc-batch-nightly',
        'visit-score-recalc-batch-nightly',
        'carteira-positivacao-snapshot-mensal'
      )
    ), '[]'::jsonb),
    'sync', (
      SELECT jsonb_build_object(
        'max_last_synced_at', max(last_synced_at),
        'age_hours', CASE WHEN max(last_synced_at) IS NULL THEN NULL
                          ELSE round(extract(epoch FROM (now() - max(last_synced_at))) / 3600.0, 1) END,
        'stale_count', count(*) FILTER (
          WHERE last_synced_at IS NULL OR last_synced_at < now() - interval '48 hours')
      )
      FROM public.carteira_assignments
      WHERE eligible
    ),
    'score_coverage', jsonb_build_object(
      'carteira', (SELECT count(*) FROM public.carteira_assignments WHERE eligible),
      'fcs_clientes', (
        SELECT count(*) FROM public.carteira_assignments ca
        WHERE ca.eligible
          AND EXISTS (SELECT 1 FROM public.farmer_client_scores f WHERE f.customer_user_id = ca.customer_user_id)
      ),
      'cvs_clientes', (
        SELECT count(*) FROM public.carteira_assignments ca
        WHERE ca.eligible
          AND EXISTS (SELECT 1 FROM public.customer_visit_scores c WHERE c.customer_user_id = ca.customer_user_id)
      )
    )
  ) INTO result;

  RETURN result;
END;
$function$;
