-- Onda D da tela Clientes — fatia 4a-1: fontes seguras ANTES do corte da 4a-2 (20261126140000).
-- Diário: docs/historico/clientes-onda-d-pii-carteira.md (§Fatia 4).
--
-- 1. public.v_pedido_snapshot_proprio — o CLIENTE lê o snapshot de contato do PRÓPRIO pedido
--    (endereço, telefone, documento gravados em sales_orders na hora do pedido). Hoje ele lê as colunas
--    cruas (`useSalesOrderDetail`, ramo não-staff); a 4a-2 fecha essas colunas a authenticated. Staff
--    segue pela RPC operacional `contato_cliente_operacional('pedido', …)` (ledger).
--    View-gate (invoker=off + barrier) com a fronteira de linha da policy `sales_orders_select_customer`
--    (auth.uid() = customer_user_id), MENOS o leitor que é ou foi staff: o pedido e o orçamento gravam
--    `customerUserId || user.id`, então sem vínculo local o TITULAR vira o VENDEDOR enquanto o snapshot é
--    do COMPRADOR (Codex, fatia 4a: 19 pedidos de 3 staff em prod, o último em 2026-11-21). Mesmo filtro do
--    precedente `selfservice_meus_pedidos` (flag is_employee) + papel staff atual. Igualdade EXATA do uuid
--    (cliente com 2 cadastros vê cada um pelo seu login, como na RLS; expandir pela raiz seria permissão nova).
--    Só SELECT: a view é auto-atualizável e, como roda como OWNER, um UPDATE por ela furaria a RLS de escrita.
-- 2. public.customer_metrics_mv deixa de entregar `document` a authenticated (grant de COLUNA; Codex P0
--    da fatia 3: qualquer employee lia o documento de toda a base). Nenhum leitor do front pede a coluna
--    (mapa de 2026-11-26); service_role (ai-ops-agent, `select("*")`) segue com a view inteira.
--    Seguro já: não depende de Publish.
-- Aplicação: bun run db:aplicar (o EXECUTOR fornece a transação — este arquivo não leva BEGIN/COMMIT).

-- ───────────────────────── 1. snapshot do próprio pedido ─────────────────────────
CREATE OR REPLACE VIEW public.v_pedido_snapshot_proprio
WITH (security_invoker = off, security_barrier = true) AS
SELECT so.id, so.customer_user_id, so.customer_address, so.customer_phone, so.customer_document
  FROM public.sales_orders so
 WHERE (SELECT auth.uid()) IS NOT NULL
   AND so.customer_user_id = (SELECT auth.uid())
   AND NOT EXISTS (SELECT 1 FROM public.user_roles r
                    WHERE r.user_id = so.customer_user_id
                      AND r.role IN ('employee'::public.app_role, 'master'::public.app_role))
   AND NOT EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.user_id = so.customer_user_id AND p.is_employee IS TRUE);

REVOKE ALL ON public.v_pedido_snapshot_proprio FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.v_pedido_snapshot_proprio TO authenticated;

-- ───────────────────────── 2. métrica sem documento ─────────────────────────
REVOKE SELECT ON public.customer_metrics_mv FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  customer_user_id, razao_social, ultima_compra_data, dias_desde_ultima_compra, pedidos_90d,
  faturamento_90d, ticket_medio_90d, faturamento_prev_90d, intervalo_medio_dias, atraso_relativo,
  is_cold_start, calculated_at
) ON public.customer_metrics_mv TO authenticated;

DO $post$
DECLARE
  c text;
  v_faltando text[];
BEGIN
  -- view-gate: existe, invoker=off, barrier, sem anon, só SELECT para authenticated
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.v_pedido_snapshot_proprio'::regclass
                    AND reloptions @> ARRAY['security_invoker=off', 'security_barrier=true']) THEN
    RAISE EXCEPTION 'A1 FALHOU: v_pedido_snapshot_proprio sem invoker=off/barrier — leria como invoker e o cliente perderia o snapshot no corte';
  END IF;
  IF has_table_privilege('anon', 'public.v_pedido_snapshot_proprio', 'SELECT') THEN
    RAISE EXCEPTION 'A2 FALHOU: anon le public.v_pedido_snapshot_proprio';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.v_pedido_snapshot_proprio', 'SELECT') THEN
    RAISE EXCEPTION 'A3 FALHOU: authenticated sem SELECT em v_pedido_snapshot_proprio — o cliente perderia o snapshot';
  END IF;
  -- lista de privilégios = "algum deles" (PG17): aqui é a semântica certa — nenhuma escrita pode passar
  IF has_table_privilege('authenticated', 'public.v_pedido_snapshot_proprio', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'A4 FALHOU: authenticated escreve por v_pedido_snapshot_proprio (view de OWNER furaria a RLS de escrita)';
  END IF;
  -- métrica: documento fechado, demais colunas abertas, service_role intacto
  IF has_column_privilege('authenticated', 'public.customer_metrics_mv', 'document', 'SELECT')
     OR has_column_privilege('anon', 'public.customer_metrics_mv', 'document', 'SELECT') THEN
    RAISE EXCEPTION 'A5 FALHOU: customer_metrics_mv.document segue aberto pela API';
  END IF;
  FOREACH c IN ARRAY ARRAY['customer_user_id', 'razao_social', 'ultima_compra_data', 'dias_desde_ultima_compra',
                           'pedidos_90d', 'faturamento_90d', 'ticket_medio_90d', 'faturamento_prev_90d',
                           'intervalo_medio_dias', 'atraso_relativo', 'is_cold_start', 'calculated_at'] LOOP
    IF NOT has_column_privilege('authenticated', 'public.customer_metrics_mv', c, 'SELECT') THEN
      v_faltando := array_append(v_faltando, c);
    END IF;
  END LOOP;
  IF v_faltando IS NOT NULL THEN
    RAISE EXCEPTION 'A6 FALHOU: customer_metrics_mv perdeu colunas de metrica para authenticated: % — a 360/fila/roteirizador quebrariam', v_faltando;
  END IF;
  IF NOT has_table_privilege('service_role', 'public.customer_metrics_mv', 'SELECT') THEN
    RAISE EXCEPTION 'A7 FALHOU: service_role perdeu customer_metrics_mv (ai-ops-agent le select *)';
  END IF;
  IF pg_get_viewdef('public.v_pedido_snapshot_proprio'::regclass) !~ 'is_employee' THEN
    RAISE EXCEPTION 'A8 FALHOU: v_pedido_snapshot_proprio sem excluir titular staff — o vendedor leria o snapshot do comprador';
  END IF;
  RAISE NOTICE 'fatia 4a-1 ok: v_pedido_snapshot_proprio (self, so SELECT) + customer_metrics_mv sem document';
END
$post$;
