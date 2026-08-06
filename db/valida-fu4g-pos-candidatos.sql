-- Validação pós-apply do FU4-G (migration 20260720120000_authz_cap_compras_ler_pos_candidatos_fu4g.sql).
--   ~/.config/afiacao/psql-ro -X -f db/valida-fu4g-pos-candidatos.sql
-- 6 linhas, todas devem vir `t`.
--
-- ⚠️ SÓ CATÁLOGO — roda de QUALQUER role, inclusive read-only sem EXECUTE (lição do FU4-E:
-- validação que INVOCA o objeto mente por resolução de tipo e por ACL, e o falso NEGATIVO
-- empurra a re-aplicar algo que está são). Ver docs/agent/database.md.
--
-- ⚠️ Os regex de CHAMADA são ancorados em `((SELECT` de propósito: o corpo desta função MENCIONA
-- os dois gates em COMENTÁRIO (a história do `IS NOT TRUE` é preservada). Um regex solto pelo
-- NOME classificaria a menção como chamada e daria falso-positivo nos dois sentidos.

SELECT 'gate NOVO presente como CHAMADA' AS check,
       pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure)
         ~ 'private\.cap_compras_ler\s*\(\s*\(\s*SELECT' AS ok
UNION ALL
SELECT 'gate ANTIGO ausente como CHAMADA (menção em comentário é OK)',
       pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure)
         !~ '(public\.|private\.)?pode_ver_carteira_completa\s*\(\s*\(\s*SELECT'
UNION ALL
-- ancorado na CHAMADA: o comentário escrito pela própria migration contém
-- "cap_compras_ler … IS NOT TRUE", e um regex solto casaria ali (teatro apanhado na falsificação C).
SELECT 'IS NOT TRUE preservado NA CHAMADA (defesa em profundidade)',
       pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure)
         ~ 'cap_compras_ler\(\(SELECT auth\.uid\(\)\)\)\)\s+IS NOT TRUE'
UNION ALL
-- o gate é cron-or-staff: o 1º AND deixa o uid NULL do pg_cron passar ANTES da capability.
-- Se este sumir, o cron morre em silêncio e a fila de atenção para de ser alimentada.
SELECT 'guarda do CRON preservada (uid NULL passa)',
       pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure)
         ~ 'IF \(SELECT auth\.uid\(\)\) IS NOT NULL'
UNION ALL
SELECT 'atributos preservados (SECDEF + STABLE + search_path)',
       (SELECT p.prosecdef AND p.provolatile = 's'
               AND array_to_string(p.proconfig, ',') LIKE '%search_path%'
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'reposicao_pos_candidatos')
UNION ALL
SELECT 'ACL preservado: authenticated executa, anon não',
       has_function_privilege('authenticated','public.reposicao_pos_candidatos(text)','EXECUTE')
       AND NOT has_function_privilege('anon','public.reposicao_pos_candidatos(text)','EXECUTE');
