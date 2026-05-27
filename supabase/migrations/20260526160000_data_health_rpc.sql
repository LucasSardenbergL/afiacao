-- Sentinela de Saúde de Dados — RPC on-demand de diagnóstico (Fase 1: financeiro + carteira).
-- Verdade primária = frescor de tabela + fin_sync_log. net._http_response = evidência (Fase 2).
-- cron.job_run_details NÃO é fonte (reporta 'succeeded' mesmo em 401).
-- Redação por papel: full (master/gestor) vê erro/causa/como-resolver; demais veem só banner-safe.
-- SEM VERDE SILENCIOSO: o que não consegue provar => 'unknown'/'broken'.

CREATE OR REPLACE FUNCTION public.get_data_health()
RETURNS TABLE (
  source text, domain text, status text,
  age_seconds bigint, expected_max_age_seconds bigint, freshness_basis text,
  message text, last_error text, probable_cause text, how_to_fix text, severity text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_full boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: não autenticado' USING ERRCODE = '42501';
  END IF;
  -- audiência full = master OU gestor comercial (helper existente). COALESCE => fail-closed.
  v_full := COALESCE(public.pode_ver_carteira_completa(auth.uid()), false);

  RETURN QUERY
  WITH checks AS (
    -- ── FINANCEIRO: saldo bancário (frescor por saldo_data) ──
    SELECT 'saldo_bancario'::text AS source, 'financeiro'::text AS domain,
      CASE
        WHEN max(cc.saldo_data) IS NULL THEN 'broken'
        WHEN now() - max(cc.saldo_data)::timestamptz > interval '36 hours' THEN 'stale'
        ELSE 'ok'
      END AS status,
      EXTRACT(EPOCH FROM now() - max(cc.saldo_data)::timestamptz)::bigint AS age_seconds,
      (36*3600)::bigint AS expected_max_age_seconds,
      'max_saldo_data'::text AS freshness_basis,
      CASE WHEN max(cc.saldo_data) IS NULL
           THEN 'Saldo bancário nunca sincronizou'
           ELSE 'Saldo bancário: último sync ' || to_char(max(cc.saldo_data), 'DD/MM') END AS message,
      NULL::text AS last_error,
      CASE WHEN max(cc.saldo_data) IS NULL THEN 'ListarExtrato falhando ou nunca rodou' ELSE NULL END AS probable_cause,
      'Rode sync_contas_correntes no chat do Lovable e cheque os logs do omie-financeiro'::text AS how_to_fix,
      'critical'::text AS severity
    FROM public.fin_contas_correntes cc WHERE cc.ativo = true

    UNION ALL
    -- ── FINANCEIRO: contas a receber (frescor por updated_at) ──
    SELECT 'contas_receber', 'financeiro',
      CASE WHEN max(cr.updated_at) IS NULL THEN 'broken'
           WHEN now() - max(cr.updated_at) > interval '26 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(cr.updated_at))::bigint, (26*3600)::bigint, 'max_updated_at',
      'Contas a receber: atualizado ' || COALESCE(to_char(max(cr.updated_at),'DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(cr.updated_at) IS NULL THEN 'Sync CR nunca completou' ELSE NULL END,
      'Rode sync_contas_receber no Lovable', 'warning'
    FROM public.fin_contas_receber cr

    UNION ALL
    -- ── FINANCEIRO: contas a pagar ──
    SELECT 'contas_pagar', 'financeiro',
      CASE WHEN max(cp.updated_at) IS NULL THEN 'broken'
           WHEN now() - max(cp.updated_at) > interval '26 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(cp.updated_at))::bigint, (26*3600)::bigint, 'max_updated_at',
      'Contas a pagar: atualizado ' || COALESCE(to_char(max(cp.updated_at),'DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(cp.updated_at) IS NULL THEN 'Sync CP nunca completou' ELSE NULL END,
      'Rode sync_contas_pagar no Lovable', 'warning'
    FROM public.fin_contas_pagar cp

    UNION ALL
    -- ── FINANCEIRO: erro explícito recente em fin_sync_log ──
    SELECT 'omie_sync_financeiro', 'omie_sync',
      CASE WHEN bool_or(l.status = 'error') THEN 'broken' ELSE 'ok' END,
      NULL::bigint, NULL::bigint, 'fin_sync_log',
      CASE WHEN bool_or(l.status='error') THEN 'Sync financeiro com erro nas últimas 24h' ELSE 'Sync financeiro sem erros recentes' END,
      max(l.error_message) FILTER (WHERE l.status='error'),
      CASE WHEN bool_or(l.status='error') THEN 'Falha em action de sync (ver fin_sync_log)' ELSE NULL END,
      'Cheque fin_sync_log e re-rode a action que falhou', 'critical'
    FROM public.fin_sync_log l WHERE l.completed_at > now() - interval '24 hours'

    UNION ALL
    -- ── CARTEIRA: reusa get_carteira_saude (jsonb) ──
    SELECT 'carteira_scores', 'carteira',
      COALESCE((public.get_carteira_saude() ->> 'status'), 'unknown'),
      NULL::bigint, NULL::bigint, 'calculated_at',
      'Carteira/scoring: ' || COALESCE((public.get_carteira_saude() ->> 'status'), 'desconhecido'),
      NULL, NULL, 'Re-rode calculate-scores no Lovable', 'warning'
  )
  SELECT
    c.source, c.domain,
    -- SEM VERDE SILENCIOSO: status nulo/vazio => 'unknown'
    COALESCE(NULLIF(c.status, ''), 'unknown'),
    c.age_seconds, c.expected_max_age_seconds, c.freshness_basis, c.message,
    CASE WHEN v_full THEN c.last_error ELSE NULL END,
    CASE WHEN v_full THEN c.probable_cause ELSE NULL END,
    CASE WHEN v_full THEN c.how_to_fix ELSE NULL END,
    c.severity
  FROM checks c;
END;
$$;

REVOKE ALL ON FUNCTION public.get_data_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_data_health() TO authenticated;
