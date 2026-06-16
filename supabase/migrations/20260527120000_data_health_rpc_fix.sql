-- Sentinela de Saúde de Dados — correção dos checks de carteira e omie_sync (revelados na validação).
-- 1) carteira: get_carteira_saude() não tem chave 'status' (tem crons/sync/score_coverage) → dava
--    'unknown' falso. Trocado por frescor direto de farmer_client_scores.calculated_at (alinhado ao
--    design: frescor de tabela como verdade primária).
-- 2) omie_sync: "qualquer erro em 24h = broken" era agressivo demais (flaga transitório recuperado).
--    Trocado por STATUS DO ÚLTIMO sync (estado atual), com subqueries que sempre retornam 1 linha.

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
  v_full := COALESCE(public.pode_ver_carteira_completa(auth.uid()), false);

  RETURN QUERY
  WITH checks AS (
    -- ── FINANCEIRO: saldo bancário ──
    SELECT 'saldo_bancario'::text AS source, 'financeiro'::text AS domain,
      CASE WHEN max(cc.saldo_data) IS NULL THEN 'broken'
           WHEN now() - max(cc.saldo_data)::timestamptz > interval '36 hours' THEN 'stale'
           ELSE 'ok' END AS status,
      EXTRACT(EPOCH FROM now() - max(cc.saldo_data)::timestamptz)::bigint AS age_seconds,
      (36*3600)::bigint AS expected_max_age_seconds, 'max_saldo_data'::text AS freshness_basis,
      CASE WHEN max(cc.saldo_data) IS NULL THEN 'Saldo bancário nunca sincronizou'
           ELSE 'Saldo bancário: último sync ' || to_char(max(cc.saldo_data), 'DD/MM') END AS message,
      NULL::text AS last_error,
      CASE WHEN max(cc.saldo_data) IS NULL THEN 'ListarExtrato falhando ou nunca rodou' ELSE NULL END AS probable_cause,
      'Rode sync_contas_correntes no chat do Lovable e cheque os logs do omie-financeiro'::text AS how_to_fix,
      'critical'::text AS severity
    FROM public.fin_contas_correntes cc WHERE cc.ativo = true

    UNION ALL
    -- ── FINANCEIRO: contas a receber ──
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
    -- ── OMIE SYNC: status do ÚLTIMO sync financeiro (estado atual, não "qualquer erro em 24h") ──
    SELECT 'omie_sync_financeiro'::text, 'omie_sync'::text,
      COALESCE((SELECT CASE WHEN l.status = 'error' THEN 'broken' ELSE 'ok' END
                FROM public.fin_sync_log l WHERE l.completed_at IS NOT NULL
                ORDER BY l.completed_at DESC LIMIT 1), 'unknown'),
      (SELECT EXTRACT(EPOCH FROM now() - l.completed_at)::bigint
                FROM public.fin_sync_log l WHERE l.completed_at IS NOT NULL
                ORDER BY l.completed_at DESC LIMIT 1),
      NULL::bigint, 'fin_sync_log'::text,
      'Último sync financeiro: ' || COALESCE(
        (SELECT l.status FROM public.fin_sync_log l WHERE l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1),
        'sem registro'),
      (SELECT l.error_message FROM public.fin_sync_log l
       WHERE l.status='error' AND l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1),
      CASE WHEN (SELECT l.status FROM public.fin_sync_log l WHERE l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1) = 'error'
           THEN 'A última action de sync financeiro falhou' ELSE NULL END,
      'Cheque fin_sync_log e re-rode a action que falhou'::text, 'critical'::text

    UNION ALL
    -- ── CARTEIRA: frescor de farmer_client_scores.calculated_at (scoring noturno) ──
    SELECT 'carteira_scores'::text, 'carteira'::text,
      CASE WHEN max(fcs.calculated_at) IS NULL THEN 'broken'
           WHEN now() - max(fcs.calculated_at) > interval '36 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(fcs.calculated_at))::bigint, (36*3600)::bigint, 'calculated_at',
      'Scoring de carteira: recalculado ' || COALESCE(to_char(max(fcs.calculated_at),'DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(fcs.calculated_at) IS NULL THEN 'calculate-scores nunca rodou' ELSE NULL END,
      'Re-rode calculate-scores / scoring-recalc-batch no Lovable', 'warning'
    FROM public.farmer_client_scores fcs
  )
  SELECT
    c.source, c.domain, COALESCE(NULLIF(c.status, ''), 'unknown'),
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
