-- Validacao pos-apply de 20260727120000_authz_preco_fecha_omie_products.sql
-- Cola no SQL Editor do Lovable, ou roda via ~/.config/afiacao/psql-ro -f db/valida-authz-preco-omie-products.sql
-- LE CATALOGO, nunca invoca funcao (#1462) -> mesmo resultado de qualquer role.
-- Todos os checks tem de vir `t`. Qualquer `f` = a migration nao aplicou como desenhada.

SELECT
  -- policies: exatamente 1, de SELECT, e a antiga morta
  (SELECT count(*) FROM pg_policies
     WHERE schemaname='public' AND tablename='omie_products') = 1                     AS c1_uma_policy,
  (SELECT count(*) FROM pg_policies
     WHERE schemaname='public' AND tablename='omie_products'
       AND policyname='Staff can manage products') = 0                                AS c2_antiga_morta,
  (SELECT cmd FROM pg_policies
     WHERE schemaname='public' AND tablename='omie_products') = 'SELECT'               AS c3_e_select,

  -- o gate de LEITURA e ESTRUTURALMENTE o mesmo (master OR employee) — compara o `qual`
  -- normalizado com o CANONICO pos-apply (medido aplicando a migration real num PG17
  -- descartavel, 2026-07-22). Substring (ILIKE) passaria com "master OR employee OR true" —
  -- mesma classe do #1501 (regex frouxo prova substring, nao estrutura). Padrao do repo
  -- (docs/agent/money-path.md #1490/#1501): comparar com o canonico normalizado, nao somar
  -- regex frouxos. regexp_replace SEMPRE antes do btrim — btrim sozinho nao remove `\n`, so
  -- espaco/tab nas bordas, e a comparacao nunca casaria. Remove tambem o prefixo `public.`:
  -- o deparse do Postgres qualifica ou nao o schema conforme o search_path da sessao que LE
  -- pg_policies (nao o da sessao que criou a policy) — omitir a normalizacao daria `f` num
  -- banco CORRETO se o search_path de leitura divergir do de escrita (o incidente #1490: pior
  -- que nao validar, ensina a ignorar o vermelho).
  (SELECT btrim(regexp_replace(replace(qual, 'public.', ''), '\s+', ' ', 'g'))
     FROM pg_policies WHERE schemaname='public' AND tablename='omie_products')
    = '( SELECT (has_role(( SELECT auth.uid() AS uid), ''master''::app_role) OR has_role(( SELECT auth.uid() AS uid), ''employee''::app_role)))'
                                                                                         AS c4_gate_leitura_intacto,

  -- grants: escrita fechada p/ authenticated, anon zerado, SELECT preservado, service_role vivo
  NOT has_table_privilege('authenticated','public.omie_products','TRUNCATE')           AS c5_sem_truncate,
  NOT has_table_privilege('authenticated','public.omie_products','UPDATE')             AS c6_sem_update,
  NOT has_table_privilege('authenticated','public.omie_products','INSERT')             AS c7_sem_insert,
  NOT has_table_privilege('authenticated','public.omie_products','DELETE')             AS c8_sem_delete,
  -- anon zerado inclui TRUNCATE: nao passa por RLS (e o privilegio mais perigoso da lista —
  -- o assert A5 da migration testa os dois, este check tinha metade da cobertura)
  (NOT has_table_privilege('anon','public.omie_products','SELECT')
   AND NOT has_table_privilege('anon','public.omie_products','TRUNCATE'))              AS c9_anon_zerado,
  has_table_privilege('authenticated','public.omie_products','SELECT')                 AS c10_select_preservado,
  -- sync vivo inclui INSERT: o assert A7 da migration testa INSERT e UPDATE — se o sync
  -- perder INSERT, as 6 edges do Omie quebram mesmo com UPDATE intacto
  (has_table_privilege('service_role','public.omie_products','UPDATE')
   AND has_table_privilege('service_role','public.omie_products','INSERT'))            AS c11_sync_vivo,

  -- RLS ligada
  (SELECT relrowsecurity FROM pg_class WHERE oid='public.omie_products'::regclass)     AS c12_rls_on;
