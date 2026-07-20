-- ════════════════════════════════════════════════════════════════════════════════════════════
-- VALIDAÇÃO PÓS-APPLY — FU4-H (20260720160000)
-- Cole no SQL Editor DEPOIS de aplicar a migration. As 6 linhas devem vir `t`.
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠️ Só CATÁLOGO, de propósito. Uma query que SELECIONA das 2 tabelas mentiria de duas formas:
--    · o SQL Editor roda como superuser, que BYPASSA RLS ⇒ "eu vejo tudo" não prova nada;
--    · 0 linhas pode ser tabela vazia, não policy funcionando.
--    Quem prova comportamento é db/test-authz-cap-compras-ler-alertas-fu4h.sh (PG17, SET ROLE
--    authenticated, com falsificação). Aqui só confirmamos que o objeto ficou como o desenho diz.

SELECT 'as 2 policies de SELECT estão no gate NOVO' AS check,
       count(*) = 2 AS ok
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('reposicao_alerta_pedido_minimo','reposicao_auto_aprovacao_log')
   AND p.polcmd = 'r'
   AND pg_get_expr(p.polqual, p.polrelid) ~ 'cap_compras_ler'

UNION ALL
SELECT 'NENHUMA sobrou no gate staff (user_roles)',
       count(*) = 0
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('reposicao_alerta_pedido_minimo','reposicao_auto_aprovacao_log')
   AND p.polcmd = 'r'
   AND pg_get_expr(p.polqual, p.polrelid) ~ 'user_roles'

UNION ALL
-- o nome antigo afirmava "Staff lê…", o que ficaria FALSO depois da troca.
-- ⚠️ ESCOPADO ÀS 2 TABELAS. A 1ª versão varria `pg_policy` INTEIRO com
-- `WHERE polname LIKE 'Staff lê%'` e devolvia `false` num banco CORRETO: existem ~20 policies
-- com esse prefixo em tabelas sem relação nenhuma com esta migration (des_*, fornecedor_*,
-- gmail_webhook_log, objects…). Falso negativo em validação pós-apply é pior que nenhuma
-- validação — ensina quem aplica a ignorar o vermelho. Medido na aplicação real, 2026-07-20.
SELECT 'o nome mentiroso (Staff lê…) não existe mais NAS 2 TABELAS',
       count(*) = 0
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('reposicao_alerta_pedido_minimo','reposicao_auto_aprovacao_log')
   AND p.polname LIKE 'Staff lê%'

UNION ALL
SELECT 'RLS segue LIGADA nas 2 (policy sem RLS é decorativa)',
       count(*) = 2
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('reposicao_alerta_pedido_minimo','reposicao_auto_aprovacao_log')
   AND c.relrowsecurity

UNION ALL
-- a migration não cria contrato de escrita: as 2 tabelas seguem sem policy de INSERT/UPDATE/DELETE
-- (quem escreve é o tick, SECDEF service-role-only, que bypassa RLS).
SELECT 'nenhuma policy de ESCRITA foi criada',
       count(*) = 0
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('reposicao_alerta_pedido_minimo','reposicao_auto_aprovacao_log')
   AND p.polcmd <> 'r'

UNION ALL
-- o alimentador tem de seguir intocado: SECDEF e SEM execute para authenticated.
SELECT 'o writer (tick) segue SECDEF e service-role-only',
       (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'reposicao_alerta_pedido_minimo_tick')
       AND NOT has_function_privilege('authenticated',
             'public.reposicao_alerta_pedido_minimo_tick()', 'EXECUTE');
