-- ╔════════════════════════════════════════════════════════════════════════════╗
-- ║ FU4 — split do FOR ALL broad-staff (BFLA) em sales_orders + filhas         ║
-- ║ Spec: docs/superpowers/specs/2026-07-20-sales-orders-bfla-split-escrita-   ║
-- ║       design.md                                                            ║
-- ╚════════════════════════════════════════════════════════════════════════════╝
--
-- FECHA a pendência de docs/agent/database.md §4: "sales_orders é FOR ALL, não
-- SELECT — os employees inserem, alteram e apagam pedido de venda".
--
-- O QUE MUDA (eixo VERBO+ESTADO, não ator — o eixo do ator já foi decidido no
-- #1477: 3 pessoas, todas do núcleo, leitura broad-staff de propósito):
--   1. sales_orders: FOR ALL → 4 policies, uma por comando. DELETE ganha
--      predicado de estado: só pedido NÃO materializado no Omie.
--   2. sales_orders: UPDATE table-wide → allowlist de 11 colunas (fecha
--      customer_user_id, created_by e omie_pedido_id, entre outras 14).
--   3. order_items / sales_price_history: sem policy de escrita nenhuma
--      (não têm escritor no front; os writers são service_role).
--
-- ⚠️ NÃO é master-only de propósito. As employees do atendimento lançam pedido —
--    é a função-fim delas. Ver §2 do spec antes de "corrigir" por simetria com
--    cap_compras/credito/preco_escrever (essas gateiam decisão de GESTÃO).
--
-- ⚠️ APLICAÇÃO MANUAL (Lovable não auto-aplica nome custom). Prova executável:
--    db/test-authz-sales-orders-split-escrita.sh
-- ⚠️ Validação pós-apply: db/valida-authz-sales-orders-split-escrita.sql

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- GUARD: aborta se a prod divergiu do estado medido em 2026-07-20.
-- Aceita 3 policies ALL (estado original) OU 0 (migration já aplicada) — nunca
-- um meio-termo, que indicaria apply parcial ou alteração concorrente.
-- ─────────────────────────────────────────────────────────────────────────────
DO $guard$
DECLARE
  n_all int;
BEGIN
  SELECT count(*) INTO n_all
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('sales_orders', 'order_items', 'sales_price_history')
    AND cmd = 'ALL';

  IF n_all NOT IN (0, 3) THEN
    RAISE EXCEPTION
      'ABORT: esperava 3 policies ALL (estado de 2026-07-20) ou 0 (já aplicada), achei %. Prod divergiu — remeça a medição antes de aplicar.', n_all;
  END IF;
END
$guard$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. CAPABILITY (padrão FU4 — private, SECDEF, fail-closed com COALESCE)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.cap_pedido_escrever(_uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    _uid IS NOT NULL AND (
      public.has_role(_uid, 'master'::public.app_role)
      OR public.has_role(_uid, 'employee'::public.app_role)
    ), false);
$function$;

COMMENT ON FUNCTION private.cap_pedido_escrever(uuid) IS
  'FU4/BFLA: quem escreve pedido de venda. DE PROPÓSITO inclui employee — as '
  'employees do atendimento lançam pedido, é a função-fim delas (≠ '
  'cap_compras/credito/preco_escrever, que gateiam decisão de GESTÃO e são '
  'master-only). NÃO estreitar para master-only sem reler o §2 do spec '
  '2026-07-20-sales-orders-bfla-split-escrita-design.md: o aperto desta tabela '
  'foi decidido no eixo do VERBO (allowlist de coluna + predicado de estado no '
  'DELETE), não no do ator.';

-- §7: REVOKE por nome NÃO tira PUBLIC (função nova tem proacl NULL = PUBLIC
-- implícito); e a policy EXIGE EXECUTE do caller (SECDEF troca o role só DEPOIS
-- da autorização de entrada) → authenticated precisa manter EXECUTE.
REVOKE ALL ON FUNCTION private.cap_pedido_escrever(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_pedido_escrever(uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. sales_orders — FOR ALL → uma policy POR COMANDO
--    ⚠️ NÃO usar FOR ALL USING(ler) WITH CHECK(escrever): DELETE consulta só o
--    USING (#1434/E2-FU4). Todas wrapped em InitPlan (§4: SECDEF no USING
--    reavalia POR LINHA; 30k linhas).
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Staff can manage sales orders" ON public.sales_orders;
DROP POLICY IF EXISTS "Customers can view their own sales orders" ON public.sales_orders;
DROP POLICY IF EXISTS sales_orders_select_staff   ON public.sales_orders;
DROP POLICY IF EXISTS sales_orders_select_customer ON public.sales_orders;
DROP POLICY IF EXISTS sales_orders_insert_staff   ON public.sales_orders;
DROP POLICY IF EXISTS sales_orders_update_staff   ON public.sales_orders;
DROP POLICY IF EXISTS sales_orders_delete_staff   ON public.sales_orders;

-- SELECT: broad-staff MANTIDO de propósito (decisão #1477 — o vendedor precisa
-- achar qualquer cliente para atender). Este PR não mexe no eixo da leitura.
CREATE POLICY sales_orders_select_staff ON public.sales_orders
  FOR SELECT TO authenticated
  USING (
    (SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role))
    OR (SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role))
  );

CREATE POLICY sales_orders_select_customer ON public.sales_orders
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = customer_user_id);

CREATE POLICY sales_orders_insert_staff ON public.sales_orders
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_pedido_escrever((SELECT auth.uid()))));

CREATE POLICY sales_orders_update_staff ON public.sales_orders
  FOR UPDATE TO authenticated
  USING ((SELECT private.cap_pedido_escrever((SELECT auth.uid()))))
  WITH CHECK ((SELECT private.cap_pedido_escrever((SELECT auth.uid()))));

-- DELETE: o aperto real. Pedido já materializado no Omie é INDELETÁVEL via
-- PostgREST por QUALQUER JWT — inclusive o do master, que também é vetor. A
-- exclusão legítima passa pela edge omie-vendas-sync (action 'excluir_pedido'),
-- que cancela no Omie e apaga com service_role (BYPASSRLS).
CREATE POLICY sales_orders_delete_staff ON public.sales_orders
  FOR DELETE TO authenticated
  USING (
    (SELECT private.cap_pedido_escrever((SELECT auth.uid())))
    AND omie_pedido_id IS NULL
    AND status IN ('orcamento', 'rascunho')
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. sales_orders — ALLOWLIST de UPDATE por coluna
--    Sem isto o predicado do DELETE é contornável em 2 requests:
--      PATCH  {"omie_pedido_id": null, "status": "rascunho"}  →  DELETE
--    RLS não fecha (WITH CHECK só vê a linha NOVA; RLS filtra linha, não coluna).
--
--    ⚠️⚠️ "REVOKE UPDATE", JAMAIS "REVOKE ALL": um REVOKE table-level revoga
--    TAMBÉM os privilégios de COLUNA correspondentes → REVOKE ALL destruiria os
--    grants de SELECT por coluna do PR0.0-bis (20260709163500) e quebraria a
--    leitura do front inteiro.
--
--    As 11 colunas são a UNIÃO medida dos 5 call sites de UPDATE do front.
--    ⚠️ Coluna NOVA nasce SEM este grant e some do PostgREST em silêncio —
--    ao acrescentar coluna que o front atualize, acrescente-a aqui também.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE UPDATE ON public.sales_orders FROM authenticated, anon;

GRANT UPDATE (
  items,              -- idempotency.ts, useSalesOrderEdit.ts
  subtotal,           -- idempotency.ts, useSalesOrderEdit.ts
  total,              -- idempotency.ts, useSalesOrderEdit.ts
  notes,              -- idempotency.ts, useSalesOrderEdit.ts
  customer_document,  -- idempotency.ts
  customer_address,   -- idempotency.ts
  customer_phone,     -- idempotency.ts
  ready_by_date,      -- idempotency.ts
  omie_payload,       -- useSalesOrderEdit.ts
  deleted_at,         -- soft-delete.ts, useSalesOrders.ts (soft-delete + rollback)
  status              -- SalesQuotes.tsx (orçamento → rascunho)
) ON public.sales_orders TO authenticated;

-- Higiene: arwdDxtm inclui D=TRUNCATE (RLS NÃO se aplica a TRUNCATE),
-- x=REFERENCES, t=TRIGGER, m=MAINTAIN. Nada disso serve ao PostgREST.
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.sales_orders FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. order_items + sales_price_history — SEM policy de escrita
--    Medido: ZERO escritores no front. Os writers são service_role (edge
--    sync-reprocess) e a RPC criar_pedidos_com_itens (INVOKER, mas sem EXECUTE
--    para authenticated — só service_role, que tem rolbypassrls).
--    ⚠️ O REVOKE aqui NÃO impede o CASCADE do DELETE do pai (ações referenciais
--    ignoram RLS e grants) — a proteção dos filhos vem de fechar o pai, acima.
--    Aqui não há grant de COLUNA a preservar (SELECT é table-level) → REVOKE ALL
--    é seguro, ao contrário de sales_orders.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Staff can manage order items" ON public.order_items;
DROP POLICY IF EXISTS "Customers can view their own order items" ON public.order_items;
DROP POLICY IF EXISTS order_items_select_staff    ON public.order_items;
DROP POLICY IF EXISTS order_items_select_customer ON public.order_items;

CREATE POLICY order_items_select_staff ON public.order_items
  FOR SELECT TO authenticated
  USING (
    (SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role))
    OR (SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role))
  );

CREATE POLICY order_items_select_customer ON public.order_items
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = customer_user_id);

DROP POLICY IF EXISTS "Staff can manage sales price history" ON public.sales_price_history;
DROP POLICY IF EXISTS "Customers can view their own price history" ON public.sales_price_history;
DROP POLICY IF EXISTS sales_price_history_select_staff    ON public.sales_price_history;
DROP POLICY IF EXISTS sales_price_history_select_customer ON public.sales_price_history;

CREATE POLICY sales_price_history_select_staff ON public.sales_price_history
  FOR SELECT TO authenticated
  USING (
    (SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role))
    OR (SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role))
  );

CREATE POLICY sales_price_history_select_customer ON public.sales_price_history
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = customer_user_id);

-- 2ª barreira (§4/#1422: ausência de policy fecha authenticated, não service_role;
-- e o grant DML vem do default privilege do Supabase, não de alguém que concedeu).
REVOKE ALL PRIVILEGES ON public.order_items, public.sales_price_history
  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.order_items, public.sales_price_history TO authenticated;

COMMIT;
