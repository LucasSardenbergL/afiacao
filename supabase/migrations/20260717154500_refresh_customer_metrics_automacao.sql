-- ============================================================
-- 20260717154500_refresh_customer_metrics_automacao.sql
-- Frescor de customer_metrics_mv: automação por cron + autz por IDENTIDADE POSITIVA.
-- [money-path: autz + automação]
--
-- PROBLEMA (medido via psql-ro 2026-07-17): private.customer_metrics_mv estava STALE há 22
-- dias (último refresh 2026-06-24). NÃO existia cron. A função public.refresh_customer_metrics()
-- tinha no corpo `IF auth.uid() IS NULL OR NOT staff THEN RAISE 42501` — sob service_role/pg_cron
-- o JWT não tem `sub` ⇒ auth.uid() IS NULL ⇒ RAISE ⇒ o refresh NUNCA rodava por automação (só
-- quando um staff disparava a tela AdminAnalyticsSync). Alimenta Customer360/FilaDoDia/rota de
-- contatos — decisão comercial com dado velho de semanas.
--
-- DESENHO (veredito Codex xhigh — IDENTIDADES SEPARADAS, não gate condicional):
--   `auth.uid() IS NULL` NÃO significa "é o cron" — significa "sem `sub` utilizável". Autorizar
--   automação pela AUSÊNCIA de identidade é fail-open (um token `authenticated` sem `sub` passaria).
--   Padrão do repo (refresh_oportunidade_badge, consagrado em docs/agent/database.md): refresh SEM
--   gate `auth.uid()` interno, protegido por REVOKE/GRANT service_role. A UX do staff (refresh
--   síncrono pós-import) é preservada por um WRAPPER separado que REJEITA uid nulo (gate correto
--   p/ endpoint EXCLUSIVAMENTE humano) — nunca afrouxando o primitive.
--
--   • refresh_customer_metrics()          PRIMITIVE service-only (cron + edge ai-ops-agent).
--                                         Sem gate JWT; advisory xact-lock; REVOKE authenticated;
--                                         GRANT service_role. Automação por identidade positiva.
--   • request_customer_metrics_refresh()  WRAPPER staff (frontend useAnalyticsSync). Gate rejeita
--                                         uid nulo E não-staff; GRANT authenticated. Chama o primitive.
--   • cron SQL-direto a cada 6h (não net.http_post → sem o footgun do timeout 5s do pg_net).
--
-- Hardening (Codex): SECURITY DEFINER com `SET search_path = ''` + qualificação total de TODO
-- objeto (defesa contra sequestro por search_path numa função owned-by-postgres).
-- Provado PG17 + falsificação: db/test-refresh-customer-metrics-automacao.sh
-- Coordenação: #1380 (mergeado) recria a VIEW pública + ACL; NÃO toca esta função/MV/cron
-- (objetos disjuntos — sem corrida "última a rodar vence").
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable (migration custom NÃO auto-aplica).
-- Idempotente. Transacional (a migration só CRIA os objetos; o REFRESH CONCURRENTLY roda em
-- runtime pelo cron/wrapper, fora desta transação).
-- ============================================================
BEGIN;

-- 1) PRIMITIVE service-only. Sem gate JWT (o cron/postgres não tem `sub`). Advisory xact-lock
--    evita pile-up (auto-libera em commit/rollback/statement_timeout — ≠ lock de sessão).
CREATE OR REPLACE FUNCTION public.refresh_customer_metrics()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $function$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('refresh_customer_metrics')) THEN
    RAISE NOTICE 'refresh_customer_metrics: refresh já em curso, pulando';
    RETURN;
  END IF;
  REFRESH MATERIALIZED VIEW CONCURRENTLY private.customer_metrics_mv;
END;
$function$;

-- autz na FRONTEIRA (não no corpo): PostgreSQL rejeita authenticated ANTES de executar qualquer
-- instrução como postgres. A superfície privilegiada nem é alcançada por um customer.
REVOKE EXECUTE ON FUNCTION public.refresh_customer_metrics() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.refresh_customer_metrics() TO service_role;

-- 2) WRAPPER staff: preserva o refresh síncrono do frontend (AdminAnalyticsSync → useAnalyticsSync,
--    tela viva). Endpoint EXCLUSIVAMENTE humano → REJEITA uid nulo (≠ do primitive: aqui a
--    ausência de identidade é NEGAÇÃO, não privilégio — é o que separa este desenho do gate
--    condicional fail-open). COALESCE null-hardened contra negação NULL-blind de has_role.
CREATE OR REPLACE FUNCTION public.request_customer_metrics_refresh()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL
     OR NOT (COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)
          OR COALESCE(public.has_role(v_uid, 'master'::public.app_role),   false)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  -- roda como postgres (owner) → alcança o primitive service-only independentemente do GRANT.
  PERFORM public.refresh_customer_metrics();
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.request_customer_metrics_refresh() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.request_customer_metrics_refresh() TO authenticated, service_role;

-- 3) Cron SQL-direto a cada 6h (escalonado aos :15). Chama o PRIMITIVE service-only (roda no
--    Postgres como o job-owner/postgres, sem JWT — passa pela fronteira de GRANT via service_role
--    do pg_cron). Idempotente.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'afiacao_customer_metrics_refresh_6h') THEN
    PERFORM cron.unschedule('afiacao_customer_metrics_refresh_6h');
  END IF;
END $$;
SELECT cron.schedule('afiacao_customer_metrics_refresh_6h', '15 */6 * * *',
                     'SELECT public.refresh_customer_metrics()');

COMMIT;

-- ── Validação pós-apply (rodar após o Run no SQL Editor) ──────────────────────
-- SELECT
--   (SELECT count(*) FROM private.customer_metrics_mv) > 0                         AS mv_populada,
--   to_regprocedure('public.refresh_customer_metrics()')          IS NOT NULL      AS primitive_existe,
--   to_regprocedure('public.request_customer_metrics_refresh()')  IS NOT NULL      AS wrapper_existe,
--   has_function_privilege('authenticated','public.refresh_customer_metrics()','EXECUTE')   AS auth_NAO_deve_ter_primitive,  -- deve vir false
--   has_function_privilege('service_role','public.refresh_customer_metrics()','EXECUTE')    AS service_tem_primitive,        -- deve vir true
--   has_function_privilege('authenticated','public.request_customer_metrics_refresh()','EXECUTE') AS auth_tem_wrapper,       -- deve vir true
--   (SELECT count(*) FROM cron.job WHERE jobname='afiacao_customer_metrics_refresh_6h') AS cron_agendado;   -- deve vir 1
