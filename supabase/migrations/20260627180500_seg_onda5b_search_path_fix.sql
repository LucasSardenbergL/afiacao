-- ============================================================
-- 20260627180500_seg_onda5b_search_path_fix.sql
-- Hardening — Onda 5b: CORRIGE a Onda 5 (20260627180300), que abortava com
-- "ERROR 42501: must be owner of function l2_norm" — o loop tentava ALTERAR
-- funções de EXTENSÃO (pgvector etc.), instaladas em public mas owned pela
-- extensão (não pelo role do SQL Editor).
--
-- A Onda 5 original é um DO-block atômico → o 42501 revertia TUDO (search_path
-- não chegou a ser aplicado em nenhuma função). Esta versão PULA funções de
-- extensão (pg_depend deptype='e') + backstop p/ insufficient_privilege.
-- ➜ Rodar ESTA no lugar do bloco da Onda 5 (180300).
--
-- Verificado em prod (psql-ro): das 129 funções sem search_path, 114 são de
-- extensão (o lint do Supabase as ignora) e só 15 são da app — todas owned por
-- postgres e sem referência a objeto fora de public sem qualificar.
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
      AND NOT EXISTS (                                 -- PULA funções de extensão (não somos owner → 42501)
             SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    BEGIN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public', r.sig);
    EXCEPTION WHEN insufficient_privilege THEN          -- backstop: pula (com aviso) o que não somos owner
      RAISE NOTICE 'search_path: pulada (sem ownership): %', r.sig;
    END;
  END LOOP;
END $$;
