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

  -- o gate de LEITURA continua o de antes (master OR employee) — escopado ao alvo, nao varredura
  (SELECT qual ILIKE '%master%' AND qual ILIKE '%employee%'
     FROM pg_policies WHERE schemaname='public' AND tablename='omie_products')         AS c4_gate_leitura_intacto,

  -- grants: escrita fechada p/ authenticated, anon zerado, SELECT preservado, service_role vivo
  NOT has_table_privilege('authenticated','public.omie_products','TRUNCATE')           AS c5_sem_truncate,
  NOT has_table_privilege('authenticated','public.omie_products','UPDATE')             AS c6_sem_update,
  NOT has_table_privilege('authenticated','public.omie_products','INSERT')             AS c7_sem_insert,
  NOT has_table_privilege('authenticated','public.omie_products','DELETE')             AS c8_sem_delete,
  NOT has_table_privilege('anon','public.omie_products','SELECT')                      AS c9_anon_zerado,
  has_table_privilege('authenticated','public.omie_products','SELECT')                 AS c10_select_preservado,
  has_table_privilege('service_role','public.omie_products','UPDATE')                  AS c11_sync_vivo,

  -- RLS ligada
  (SELECT relrowsecurity FROM pg_class WHERE oid='public.omie_products'::regclass)     AS c12_rls_on;
