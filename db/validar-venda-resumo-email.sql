-- Validação pós-apply (READ-ONLY, psql-ro) da 20261113110100_venda_resumo_email_controle.
--   ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/validar-venda-resumo-email.sql
-- Esperado: todas as linhas ✅ e a linha final FIM-VALIDACAO.
SELECT CASE WHEN s.semente = 'venda-r2-controle-2026-11-12' AND s.fracao_controle = 0.15 AND s.algoritmo = 'md5-32-v1'
            THEN '✅ V1 sorteio: inicio ' || s.inicio || ', ' || s.n_inicial || ' compradores, ' || s.n_inicial_controle || ' controle'
            ELSE '❌ V1 sorteio fora do desenho' END
  FROM public.venda_braco_sorteio s WHERE s.id = 1
UNION ALL
SELECT CASE WHEN count(*) = 0 THEN '✅ V2 todo braço segue a régua md5-32-v1'
            ELSE '❌ V2 ' || count(*) || ' braços fora da régua' END
  FROM public.venda_braco_comprador b, public.venda_braco_sorteio s
 WHERE b.u <> private.venda_braco_u(s.semente, b.comprador_id) OR (b.braco = 'controle') <> (b.u < s.fracao_controle)
UNION ALL
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.venda_sugestao'::regclass
                            AND tgname = 'venda_sugestao_braco_trg' AND tgenabled = 'O')
             AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'venda_sugestao_braco_ck' AND convalidated)
            THEN '✅ V3 trigger e check do braço' ELSE '❌ V3 trigger/check ausente' END
UNION ALL
SELECT CASE WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'private._venda_sugestoes_json(uuid,date)'::regprocedure) = 'ccc8189a3d2962e073a3d360581efb61'
             AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.venda_marcar_mostrada(uuid[])'::regprocedure) = '3e286aaea8d6f4c7b1bce316824d5be7'
             AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.venda_painel(date,date)'::regprocedure) = '76d2d0f050e9240392cd1362ef2d82bd'
            THEN '✅ V4 os 3 corpos recriados são os desta migration' ELSE '❌ V4 corpo divergente' END
UNION ALL
SELECT CASE WHEN NOT has_function_privilege('anon', 'public.venda_resumo_abrir(uuid)', 'EXECUTE')
             AND NOT has_function_privilege('anon', 'public.venda_resumo_painel(date,date)', 'EXECUTE')
             AND NOT has_function_privilege('authenticated', 'public.venda_resumo_preparar(date,uuid)', 'EXECUTE')
             AND NOT has_function_privilege('authenticated', 'public.venda_resumo_registrar_abertura(uuid)', 'EXECUTE')
             AND NOT has_function_privilege('public', 'public.venda_resumo_preparar(date,uuid)', 'EXECUTE')
             AND has_function_privilege('service_role', 'public.venda_resumo_registrar_abertura(uuid)', 'EXECUTE')
            THEN '✅ V5 ACL das RPCs' ELSE '❌ V5 ACL aberta/fechada fora do desenho' END
UNION ALL
SELECT CASE WHEN count(*) = 7 THEN '✅ V6 7 tabelas novas com RLS e sem leitura anon'
            ELSE '❌ V6 só ' || count(*) || ' de 7 tabelas com RLS e anon fechado' END
  FROM pg_class c
 WHERE c.oid IN ('public.venda_braco_sorteio'::regclass, 'public.venda_braco_comprador'::regclass,
                 'public.venda_resumo_config'::regclass, 'public.venda_resumo_selecao'::regclass,
                 'public.venda_resumo_item'::regclass, 'public.venda_resumo_envio'::regclass, 'public.venda_resumo_link'::regclass)
   AND c.relrowsecurity AND NOT has_table_privilege('anon', c.oid, 'SELECT')
UNION ALL
SELECT CASE WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'venda-resumo-email' AND schedule = '35 9 * * 1-5' AND active)
            THEN '✅ V7 cron venda-resumo-email 09:35 UTC seg–sex' ELSE '❌ V7 cron ausente' END
UNION ALL
SELECT CASE WHEN count(*) >= 1 AND bool_and(c.copia_user_id IS NOT NULL)
            THEN '✅ V8 ' || count(*) || ' farmer(s) configurada(s), com cópia' ELSE '❌ V8 config vazia ou sem cópia' END
  FROM public.venda_resumo_config c
UNION ALL
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'venda_sugestao' AND policyname = 'venda_sugestao_select'
                            AND qual LIKE '%braco%controle%')
            THEN '✅ V9 policy da farmer esconde o controle' ELSE '❌ V9 policy sem o filtro' END
UNION ALL
SELECT 'FIM-VALIDACAO';
