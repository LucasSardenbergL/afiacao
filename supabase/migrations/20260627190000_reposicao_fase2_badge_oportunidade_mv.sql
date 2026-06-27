-- =============================================================================
-- REPOSIÇÃO FASE 2 — materializa o COUNT do badge de oportunidade econômica.
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable.
--
-- A Fase 1 (RLS→InitPlan, 20260627170000) matou o 500; sobrou 880ms estrutural
-- (generate_series 180d → 537k linhas p/ devolver 12) que o badge paga no
-- count(*) a cada 60s. Fase 2: cachear SÓ o count do badge; a tela de
-- Oportunidades segue tempo-real (decisão de compra).
--
-- Desenho (endurecido pós-Codex): materializa só count-por-empresa (não as 25
-- colunas sensíveis), em schema `private` (não exposto ao PostgREST), atrás de
-- uma view-gate em `public` (security_invoker=off + security_barrier + gate
-- null-hardened que replica a RLS "staff vê tudo / service_role bypassa").
-- Refresh SEM gate auth.uid() interno (senão mata o cron, igual ao bug do
-- refresh_sku_ranking) — protegido por REVOKE/GRANT. Provado: db/test-reposicao-fase2-badge-mv.sh.
-- Spec: docs/superpowers/specs/2026-06-27-reposicao-fase2-materializar-badge-design.md
-- =============================================================================

-- A view-gate depende da MV → dropar a view ANTES da MV (idempotência: re-colar no SQL Editor
-- é esperado no Lovable; sem isto o DROP MATERIALIZED VIEW falha com "view depends on it").
DROP VIEW IF EXISTS public.v_oportunidade_economica_hoje_badge_cached;

-- 1) MV em private: count por empresa (superfície de vazamento = 1 inteiro, não 25 colunas)
DROP MATERIALIZED VIEW IF EXISTS private.mv_oportunidade_badge;
CREATE MATERIALIZED VIEW private.mv_oportunidade_badge AS
  SELECT empresa,
         count(*)::int AS oportunidade_count,
         now()        AS refreshed_at,
         CURRENT_DATE AS calculado_em
  FROM public.v_oportunidade_economica_hoje
  GROUP BY empresa;

-- índice único (empresa) — provado único; exigido pelo REFRESH CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS mv_oportunidade_badge_empresa_uq
  ON private.mv_oportunidade_badge (empresa);

-- a MV crua NÃO é exposta a ninguém além do owner (defense-in-depth além do schema private)
REVOKE ALL ON private.mv_oportunidade_badge FROM PUBLIC;
REVOKE ALL ON private.mv_oportunidade_badge FROM anon, authenticated;

-- 2) view-gate em public: replica a semântica da RLS original (staff vê / service_role bypassa)
CREATE VIEW public.v_oportunidade_economica_hoje_badge_cached
  WITH (security_invoker = false, security_barrier = true) AS
  SELECT empresa, oportunidade_count, refreshed_at
  FROM private.mv_oportunidade_badge
  WHERE (
        (SELECT auth.role()) = 'service_role'
     OR COALESCE((SELECT public.has_role((SELECT auth.uid()), 'master'::app_role)),   false)
     OR COALESCE((SELECT public.has_role((SELECT auth.uid()), 'employee'::app_role)), false)
  );
GRANT SELECT ON public.v_oportunidade_economica_hoje_badge_cached TO authenticated, service_role;

-- 3) função de refresh: SEM gate auth.uid() interno (mataria o cron — postgres não tem JWT);
--    proteção via REVOKE/GRANT. Advisory lock evita pile-up; CONCURRENTLY não bloqueia o badge.
CREATE OR REPLACE FUNCTION public.refresh_oportunidade_badge()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private'
AS $function$
BEGIN
  -- Advisory lock de TRANSAÇÃO (auto-libera no commit/rollback — NÃO vaza em
  -- cancelamento/statement_timeout, ≠ lock de sessão; achado Codex xhigh). Sem
  -- fallback non-concurrent cego: stale-served > travar o badge; erro propaga +
  -- watchdog alerta.
  IF NOT pg_try_advisory_xact_lock(hashtext('refresh_oportunidade_badge')) THEN
    RAISE NOTICE 'refresh_oportunidade_badge: refresh já em curso, pulando';
    RETURN;
  END IF;
  REFRESH MATERIALIZED VIEW CONCURRENTLY private.mv_oportunidade_badge;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_oportunidade_badge() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.refresh_oportunidade_badge() TO service_role;

-- 4) cron a cada 2h (escalonado aos :20). Idempotente.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'afiacao_oportunidade_badge_refresh_2h') THEN
    PERFORM cron.unschedule('afiacao_oportunidade_badge_refresh_2h');
  END IF;
END $$;
SELECT cron.schedule('afiacao_oportunidade_badge_refresh_2h', '20 */2 * * *',
                     'SELECT public.refresh_oportunidade_badge()');

-- Validação pós-apply. ⚠️ mv_status DEVE vir ✅: se a MV nascer VAZIA, o owner que
-- aplicou/refresca NÃO tem BYPASSRLS (a fonte é security_invoker + RLS; sob auth.uid()=NULL
-- um role não-bypass vê 0 linhas) — não confiar no badge até investigar o owner.
SELECT
  CASE WHEN (SELECT count(*) FROM private.mv_oportunidade_badge) > 0
       THEN '✅ MV populada (' || (SELECT count(*) FROM private.mv_oportunidade_badge)::text || ' empresa(s))'
       ELSE '❌ MV VAZIA — owner do refresh sem BYPASSRLS? RLS barrou a leitura da fonte. NÃO confiar no badge.'
  END AS mv_status,
  (SELECT count(*) FROM pg_matviews WHERE schemaname='private' AND matviewname='mv_oportunidade_badge') AS mv_existe_1,
  (SELECT count(*) FROM pg_views WHERE schemaname='public' AND viewname='v_oportunidade_economica_hoje_badge_cached') AS view_existe_1,
  (SELECT count(*) FROM cron.job WHERE jobname='afiacao_oportunidade_badge_refresh_2h')     AS cron_agendado_1;
