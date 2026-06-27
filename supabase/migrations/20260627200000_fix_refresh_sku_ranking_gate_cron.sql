-- =============================================================================
-- FIX: refresh_sku_ranking_negociacao() — remove o gate auth.uid() que MATAVA o cron.
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable.
--
-- Bug (achado 2026-06-27 via psql-ro): o cron `afiacao_ranking_refresh_semanal` está
-- FALHANDO desde 2026-06-22 com "Acesso negado: requer perfil staff" (42501). A função
-- (SECURITY DEFINER) tinha um gate `IF auth.uid() IS NULL OR NOT has_role(...) RAISE 42501`;
-- o pg_cron roda como `postgres` SEM JWT → auth.uid()=NULL → 42501 → cron morto SILENCIOSO.
-- A MV private.mv_sku_ranking_negociacao_paralela (alimenta v_sugestao_negociacao_ativa,
-- badge de sugestões de negociação) ficou stale ~5 dias.
--
-- Fix (lição docs/agent/reposicao.md "gate auth.uid/auth.role MATA cron SQL-local"):
-- remover o gate runtime; proteger por REVOKE/GRANT (o `postgres` do cron passa por cima
-- dos grants; um authenticated não-staff não chama via PostgREST porque o EXECUTE é revogado).
-- Só o cron chama (verificado: zero consumidor de código). Corpo = pré-flight de prod, sem o IF.
-- Provado em PG17: db/test-refresh-ranking-gate-cron.sh
-- =============================================================================

CREATE OR REPLACE FUNCTION public.refresh_sku_ranking_negociacao()
 RETURNS TABLE(skus_ranqueados integer, atualizado_em timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
BEGIN
  -- SEM gate auth.uid() interno: matava o cron (postgres sem JWT → 42501). A proteção é
  -- o REVOKE/GRANT abaixo (NÃO um gate runtime). Lição reposicao.md.
  REFRESH MATERIALIZED VIEW CONCURRENTLY private.mv_sku_ranking_negociacao_paralela;
  RETURN QUERY SELECT COUNT(*)::int, now() FROM private.mv_sku_ranking_negociacao_paralela;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_sku_ranking_negociacao() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.refresh_sku_ranking_negociacao() TO service_role;

-- Validação pós-apply: gate removido + grants corretos. Esperado: ✅ / f / t.
SELECT
  CASE WHEN pg_get_functiondef('public.refresh_sku_ranking_negociacao'::regproc) ILIKE '%Acesso negado%'
       THEN '❌ ainda tem o gate auth.uid()' ELSE '✅ gate removido (cron volta a refrescar)' END AS gate_status,
  has_function_privilege('authenticated', 'public.refresh_sku_ranking_negociacao()', 'EXECUTE') AS authenticated_exec_esperado_f,
  has_function_privilege('service_role',  'public.refresh_sku_ranking_negociacao()', 'EXECUTE') AS service_role_exec_esperado_t;

-- ⚠️ Depois de aplicar, FORCE 1 refresh p/ recuperar a MV stale (rodar como service_role/no SQL Editor):
--   SELECT public.refresh_sku_ranking_negociacao();
