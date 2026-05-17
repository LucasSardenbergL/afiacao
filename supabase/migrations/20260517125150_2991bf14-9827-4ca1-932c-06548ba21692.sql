-- Soft-delete em sales_orders pra audit trail de exclusões.
-- Identificado pela auditoria (CLAUDE.md §10): SalesOrders.deleteOrder hoje chama
-- excluir_pedido no Omie direto sem registro local de quando/por-quem foi excluído.
-- Esta migration adiciona deleted_at pra:
--   1. Audit trail (compliance) — sabemos exatamente quando cada pedido foi removido
--   2. Optimistic rollback — se chamada do Omie falhar, restauramos deleted_at = NULL
--   3. Base pra "Lixeira" / restore UI no futuro (out of scope deste PR)
--
-- UX permanece como "excluir permanentemente do usuário" — soft-delete é
-- transparente pra ele. O Omie ainda é chamado (sem mudança semântica).

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.sales_orders.deleted_at IS
  'Soft-delete timestamp. NULL = ativo. SalesOrders.deleteOrder seta antes de chamar Omie; se Omie falhar, rollback pra NULL. Queries default filtram WHERE deleted_at IS NULL.';

-- Index parcial — queries default filtram WHERE deleted_at IS NULL.
-- Partial index é mais eficiente que index full porque a maioria das rows nunca
-- vai estar excluída.
CREATE INDEX IF NOT EXISTS idx_sales_orders_active
  ON public.sales_orders (created_at DESC)
  WHERE deleted_at IS NULL;
