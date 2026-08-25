-- Diagnóstico read-only: o ACL REAL de EXECUTE das funções de `public`.
--
-- Por que existe: `scripts/authz-funcoes.test.ts` valida um MANIFESTO em TypeScript
-- (AUTHZ_MANIFEST / ACKNOWLEDGED_SENSITIVE / ACL_ONLY_INTERNAL) e tem um assert
-- "nenhuma entrada permite anon (estado medido em prod)". "Medido em prod" é a ORIGEM
-- do dado, não o que o assert verifica: ele percorre a estrutura, não o banco. Estas
-- queries são a fronteira — quem de fato decide quem executa o quê.
--
-- Classe: docs/historico/verificar-sonda-versao.md §9/§10 (o NOME prova o efeito).
-- Rodar com o wrapper read-only: ~/.config/afiacao/psql-ro -f db/diagnostico/authz-funcoes-acl-real.sql
--
-- ESCRITA NUNCA SAI DAQUI. Se aparecer função indevidamente aberta, o REVOKE vai para o
-- SQL Editor do Lovable, colado pelo founder (docs/agent/database.md §1). E cuidado com o
-- no-op medido no #1991: REVOKE ... FROM PUBLIC NÃO tira anon/authenticated quando existe
-- grant explícito — revogue NOMEANDO as roles.

\echo '=== 1. ACL real de EXECUTE por função (proacl NULL primeiro = default do Postgres) ==='
SELECT n.nspname || '.' || p.proname AS funcao,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef AS security_definer,
       coalesce(p.proacl::text, '(default: PUBLIC pode EXECUTE)') AS acl
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY (p.proacl IS NULL) DESC, p.proname;

\echo '=== 2. O furo direto: funções que anon OU authenticated podem executar hoje ==='
SELECT n.nspname || '.' || p.proname AS funcao,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef AS security_definer,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_pode,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_pode
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (has_function_privilege('anon', p.oid, 'EXECUTE')
    OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
ORDER BY anon_pode DESC, p.prosecdef DESC, p.proname;

\echo '=== 3. Pior caso: SECURITY DEFINER (bypassa RLS) executável por anon ==='
SELECT n.nspname || '.' || p.proname AS funcao,
       pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
ORDER BY p.proname;

\echo '=== 4. O rastro do DROP+CREATE: proacl NULL = ninguém emitiu GRANT/REVOKE desde a criação ==='
-- Este é o estado que `DROP FUNCTION` + `CREATE` produz (só CREATE OR REPLACE preserva o
-- ACL), e o default de EXECUTE em função inclui PUBLIC. Reabre sem nenhuma linha de GRANT
-- no repo — que é exatamente o que o gate textual de migrations não consegue ver.
SELECT n.nspname || '.' || p.proname AS funcao, p.prosecdef AS security_definer
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proacl IS NULL AND p.prokind = 'f'
ORDER BY p.prosecdef DESC, p.proname;
