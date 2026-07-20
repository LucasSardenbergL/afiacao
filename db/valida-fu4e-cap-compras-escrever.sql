-- Validação pós-apply do FU4-E (migration 20260719120000_authz_cap_compras_escrever_fu4e.sql).
--   ~/.config/afiacao/psql-ro -X -f db/valida-fu4e-cap-compras-escrever.sql
-- 6 linhas, todas devem vir `t`.
--
-- ⚠️ SÓ CATÁLOGO — de propósito: roda de QUALQUER role, inclusive um read-only sem EXECUTE.
-- O rodapé da migration (imutável, já aplicada) traz uma versão que CHAMA a função, e ela mente
-- de duas formas — ambas mordidas em 2026-07-20, validando esta própria migration:
--   · `NULL` sem cast é `unknown` ⇒ o PG não resolve a assinatura e devolve "function
--     private.cap_compras_escrever(unknown) does not exist", que se LÊ como "não aplicou" —
--     com a função aplicada e correta.
--   · executar exige EXECUTE ⇒ sob role read-only vem "permission denied", que é o REVOKE
--     FUNCIONANDO, e também se lê como falha.
-- Validação que falha quando a migration DEU CERTO é pior que nenhuma: custa uma re-aplicação
-- desnecessária. Por isso tudo abaixo lê pg_proc/pg_get_functiondef em vez de invocar o objeto.

SELECT 'cap existe (assinatura uuid)' AS check,
       to_regprocedure('private.cap_compras_escrever(uuid)') IS NOT NULL AS ok
UNION ALL
SELECT 'corpo é master-only e fail-closed',
       pg_get_functiondef('private.cap_compras_escrever(uuid)'::regprocedure)
         ~ 'has_role\(_uid, ''master''::public\.app_role\)'
       AND pg_get_functiondef('private.cap_compras_escrever(uuid)'::regprocedure)
         ~ '_uid IS NOT NULL'
UNION ALL
-- negativo: o corpo não pode ter voltado a conceder por papel comercial
SELECT 'corpo NÃO concede a papel comercial',
       pg_get_functiondef('private.cap_compras_escrever(uuid)'::regprocedure)
         !~ 'gerencial|estrategico|pode_ver_carteira_completa'
UNION ALL
SELECT 'as 3 RPCs com o gate NOVO',
       count(*) = 3 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('despinar_parametro','reverter_parametro_auto','reverter_run_auto')
          AND pg_get_functiondef(p.oid) ~ 'private\.cap_compras_escrever\s*\('
UNION ALL
SELECT 'nenhuma das 3 no gate ANTIGO',
       count(*) = 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('despinar_parametro','reverter_parametro_auto','reverter_run_auto')
          AND pg_get_functiondef(p.oid) ~ '(public\.|private\.)?pode_ver_carteira_completa\s*\('
UNION ALL
-- ACL por has_function_privilege (lê catálogo; não executa nada)
SELECT 'ACL: authenticated+service_role sim, anon não',
       has_function_privilege('authenticated','private.cap_compras_escrever(uuid)','EXECUTE')
       AND has_function_privilege('service_role','private.cap_compras_escrever(uuid)','EXECUTE')
       AND NOT has_function_privilege('anon','private.cap_compras_escrever(uuid)','EXECUTE');
