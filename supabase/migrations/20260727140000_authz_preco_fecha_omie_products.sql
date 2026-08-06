-- Fecha a ESCRITA em public.omie_products — o preço de tabela sai do alcance do `employee`.
--
-- ESTADO MEDIDO EM PROD (psql-ro, 2026-07-21):
--   · UMA policy, FOR ALL, para {authenticated}:
--       "Staff can manage products"
--         USING/WITH CHECK ( SELECT (has_role((SELECT auth.uid()),'master')
--                                 OR has_role((SELECT auth.uid()),'employee')) )
--     => qualquer employee (hoje 2 vendedoras, ambas commercial_role=farmer) da UPDATE em
--        valor_unitario, o PRECO DE TABELA.
--   · relacl: authenticated=arwdDxtm E anon=arwdDxtm. O `D` e TRUNCATE, que NAO passa por RLS:
--     trocar policy nao revoga GRANT. Sem REVOKE, o mesmo employee apaga os 7.966 SKUs.
--   · 7.966 linhas; 1.942 com valor_unitario=0; 6.024 positivos.
--
-- WRITERS (enumerados no codigo, 2026-07-21): omie-vendas-sync, omie-analytics-sync,
-- sync-reprocess, tint-omie-sync, omie-sync-metadados, omie-sync-status-produtos — TODAS edges
-- com SERVICE_ROLE_KEY. service_role bypassa RLS e tem grant proprio, entao revogar de
-- authenticated/anon NAO toca o sync. Nenhum writer roda como `authenticated`.
-- A unica funcao SQL que escreve, tint_marcar_bases_mixmachine, e SECURITY DEFINER (bypassa RLS)
-- e nao toca valor_unitario.
--
-- NAO HA UI DE EDICAO DE PRECO: todos os hits de valor_unitario em src/ sao leitura. O unico
-- onUpdate(...,'valor_unitario',...) e de sales_order_items (item do pedido), outra tabela.
--
-- ESCOPO: escrita. A LEITURA fica IDENTICA a de hoje (master OR employee), inclusive o wrap de
-- InitPlan. Nao ha policy de escrita de proposito — nem employee nem master escrevem via API.
-- private.cap_preco_escrever(uuid) existe em prod e e master-only; se um dia houver UI de
-- correcao manual pelo master, o caminho e GRANT UPDATE + policy com ela. Ate la, YAGNI.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- PRECONDICAO — aborta se aparecer policy que este desenho nao conhece.
-- Policies permissivas combinam com OR: se uma sessao paralela criou outra policy, o
-- DROP+CREATE daqui a deixaria VIVA e o gate NAO fecharia. Idempotente nos dois sentidos —
-- na 1a rodada so a antiga existe, na 2a so a nova.
-- ─────────────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  v_desconhecidas int;
  v_nomes         text;
BEGIN
  SELECT count(*), COALESCE(string_agg(policyname, ', '), '')
    INTO v_desconhecidas, v_nomes
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename  = 'omie_products'
    AND policyname NOT IN ('Staff can manage products', 'omie_products_select_staff');

  IF v_desconhecidas <> 0 THEN
    RAISE EXCEPTION
      'precondicao FALHOU: % policy(s) inesperada(s) em omie_products (%). Permissivas combinam com OR — fechar so as conhecidas NAO fecha o gate. Reconcilie antes de aplicar.',
      v_desconhecidas, v_nomes;
  END IF;
END
$pre$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. GRANTS. Trocar policy NAO mexe em GRANT, e TRUNCATE/REFERENCES/TRIGGER nao passam por RLS.
--    REVOKE de PUBLIC e no-op util aqui: o Supabase concede por NOME (default privilege).
--    service_role NAO e tocado — e o writer.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE public.omie_products FROM PUBLIC;
REVOKE ALL ON TABLE public.omie_products FROM anon;
REVOKE ALL ON TABLE public.omie_products FROM authenticated;

-- SELECT volta para authenticated porque a RLS e que decide QUEM le (policy abaixo).
-- Sem o grant, a negacao viria do PRIVILEGIO, a policy nunca seria exercida e o assert de RLS
-- viraria tautologia — o P3 da rodada 2 do Codex no #1488.
GRANT SELECT ON TABLE public.omie_products TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. POLICIES. A FOR ALL sai; entra UMA de leitura com o gate IDENTICO ao de hoje.
--    Escrita fica sem policy de proposito (ver cabecalho).
--    Schema qualificado p/ nao depender do search_path do SQL Editor; o objeto resultante e o
--    mesmo (policies guardam a expressao por OID depois de criadas — licao #1427).
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Staff can manage products" ON public.omie_products;
DROP POLICY IF EXISTS omie_products_select_staff  ON public.omie_products;

CREATE POLICY omie_products_select_staff ON public.omie_products
  FOR SELECT
  TO authenticated
  USING ((SELECT (public.has_role((SELECT auth.uid()), 'master'::public.app_role)
               OR public.has_role((SELECT auth.uid()), 'employee'::public.app_role))));

ALTER TABLE public.omie_products ENABLE ROW LEVEL SECURITY;

COMMENT ON POLICY omie_products_select_staff ON public.omie_products IS
  'Leitura do catalogo por staff (master OR employee) — gate IDENTICO ao da policy "Staff can manage products" que substituiu. A diferenca e a ESCRITA: aquela era FOR ALL e deixava qualquer employee reescrever valor_unitario (o preco de tabela) e dar TRUNCATE. Escrita agora e exclusiva de service_role (as 6 edges de sync); nao ha policy de escrita.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. ASSERTS DE APLICACAO — dentro da transacao; qualquer um falha, tudo volta.
--    Nao substituem o harness (db/test-authz-preco-omie-products.sh); pegam o caso em que a
--    PROD divergiu do que este arquivo assumiu.
-- ─────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_antigas    int;
  v_n_policies int;
  v_rls        boolean;
BEGIN
  SELECT count(*) INTO v_antigas
  FROM pg_policies
  WHERE schemaname='public' AND tablename='omie_products'
    AND policyname = 'Staff can manage products';
  IF v_antigas <> 0 THEN
    RAISE EXCEPTION 'A1 FALHOU: a policy antiga sobreviveu — permissivas combinam com OR, o gate nao fechou';
  END IF;

  SELECT count(*) INTO v_n_policies
  FROM pg_policies WHERE schemaname='public' AND tablename='omie_products';
  IF v_n_policies <> 1 THEN
    RAISE EXCEPTION 'A2 FALHOU: esperava exatamente 1 policy em omie_products, encontrei %', v_n_policies;
  END IF;

  IF has_table_privilege('authenticated','public.omie_products','TRUNCATE') THEN
    RAISE EXCEPTION 'A3 FALHOU: authenticated ainda tem TRUNCATE (nao passa por RLS — apagaria os 7.966 SKUs)';
  END IF;

  IF has_table_privilege('authenticated','public.omie_products','INSERT')
     OR has_table_privilege('authenticated','public.omie_products','UPDATE')
     OR has_table_privilege('authenticated','public.omie_products','DELETE') THEN
    RAISE EXCEPTION 'A4 FALHOU: authenticated ainda tem escrita em omie_products';
  END IF;

  IF has_table_privilege('anon','public.omie_products','SELECT')
     OR has_table_privilege('anon','public.omie_products','TRUNCATE') THEN
    RAISE EXCEPTION 'A5 FALHOU: anon ainda tem privilegio em omie_products';
  END IF;

  IF NOT has_table_privilege('authenticated','public.omie_products','SELECT') THEN
    RAISE EXCEPTION 'A6 FALHOU: authenticated perdeu SELECT — a policy nunca seria exercida e o gate viraria tautologia';
  END IF;

  IF NOT has_table_privilege('service_role','public.omie_products','INSERT')
     OR NOT has_table_privilege('service_role','public.omie_products','UPDATE') THEN
    RAISE EXCEPTION 'A7 FALHOU: service_role perdeu escrita — as 6 edges de sync do Omie quebrariam';
  END IF;

  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid='public.omie_products'::regclass;
  IF NOT v_rls THEN
    RAISE EXCEPTION 'A8 FALHOU: RLS desabilitada em omie_products';
  END IF;

  RAISE NOTICE 'omie_products fechada: 1 policy (SELECT staff), authenticated sem escrita, anon zerado, service_role intacto';
END
$post$;

COMMIT;
