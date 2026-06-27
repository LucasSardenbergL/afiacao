-- ============================================================
-- 20260627180300_seg_onda5_search_path.sql
-- Hardening de segurança — Onda 5 ("Function Search Path Mutable")
--
-- Fixa search_path nas funções do schema public que hoje não têm SET search_path.
-- Contexto (verificado em prod via psql-ro):
--   - são ~129 funções, TODAS security INVOKER (0 SECURITY DEFINER) → não há
--     escalonamento de privilégio; é o achado de menor risco real.
--   - search_path=public alinha com o padrão dominante do repo (125 funcs já assim)
--     e é seguro: os roles anon/authenticated NÃO têm 'extensions' no search_path
--     default, então funções que já rodam sob eles não dependem de extensions sem
--     qualificar — fixar 'public' não muda a resolução para esses callers.
--   - preserva qualquer outro SET existente (ex.: SET work_mem) — só ADICIONA search_path.
-- Idempotente: re-rodar pega apenas as que ainda faltam.
-- ============================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'                              -- só funções (não aggregates/procedures)
      AND (p.proconfig IS NULL OR NOT EXISTS (
             SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'))
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public', r.sig);
  END LOOP;
END $$;
