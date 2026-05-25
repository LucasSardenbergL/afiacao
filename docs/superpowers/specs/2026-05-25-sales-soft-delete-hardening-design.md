# Soft-delete de pedidos — Hardening — Design Spec

> **Data:** 2026-05-25
> **Status:** aprovado no brainstorming
> **Contexto:** auditoria do "SalesOrders.deleteOrder soft-delete" (§10 do CLAUDE.md) revelou que o soft-delete **já está implementado e em produção** (coluna `deleted_at`, partial index `idx_sales_orders_active`, optimistic + rollback, versão bulk). A nota do §10 está desatualizada. Este trabalho **endurece** o que existe, sem reimplementar.

## Goal

Cobrir com teste a lógica de soft-delete de pedido (caminho do dinheiro: `deleted_at` + Omie `excluir_pedido` + rollback), remover casts `as never` que viraram dead-weight, e corrigir a nota obsoleta do CLAUDE.md. **Sem migration. Sem mudança de comportamento.**

## Estado atual (relevante)

- `sales_orders.deleted_at` existe (nos tipos `Row`/`Insert`/`Update` → produção).
- `useSalesOrders.deleteOrder` (`src/components/salesOrders/useSalesOrders.ts:153-205`): optimistic remove do cache → `UPDATE deleted_at=now()` → Omie `excluir_pedido` → se Omie falha, `UPDATE deleted_at=null` (rollback) + restaura cache; se UPDATE falha, restaura cache e **não** chama Omie.
- `deleteSelected` (bulk, :208-288): batch `UPDATE ... .in('id', ...)` + Omie sequencial + rollback parcial dos que falharam.
- Os `UPDATE` usam `{ deleted_at: ... } as never` com comentário "ainda não no generated Database type" — **comentário obsoleto**: o tipo `Update` já tem `deleted_at?: string | null`, então o cast é desnecessário.
- **Sem teste** para nenhum dos dois fluxos.

## Decisões

1. **Extrair só o fluxo single** (`softDeleteOrder`) num helper testável; o bulk NÃO é refatorado (lógica de batch + rollback parcial é distinta), só perde os casts mortos.
2. **Comportamento idêntico** — extração verbatim; cache/toast/seleção continuam no hook.
3. **Helper importa `supabase` direto** (padrão dos serviços existentes — `picking-confirm.ts`, `recebimento-confirm.ts`; teste mocka o módulo).

## Arquitetura

### `src/components/salesOrders/soft-delete.ts` (novo)

```ts
import { supabase } from '@/integrations/supabase/client';

export type SoftDeleteResult =
  | { ok: true }
  | { ok: false; stage: 'supabase' | 'omie'; message: string };

/**
 * Soft-delete de UM pedido (caminho do dinheiro):
 *  1. UPDATE sales_orders SET deleted_at=now() (audit trail antes do Omie).
 *  2. Omie excluir_pedido.
 *  3. Se o Omie falha, rollback (deleted_at=null) — pedido volta a ativo.
 * Não mexe em cache/UI (responsabilidade do caller).
 */
export async function softDeleteOrder(order: { id: string; omie_pedido_id: number | null }): Promise<SoftDeleteResult> {
  const { error: softErr } = await supabase
    .from('sales_orders')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', order.id);
  if (softErr) return { ok: false, stage: 'supabase', message: softErr.message };

  const { error: omieErr } = await supabase.functions.invoke('omie-vendas-sync', {
    body: { action: 'excluir_pedido', sales_order_id: order.id, omie_pedido_id: order.omie_pedido_id },
  });
  if (omieErr) {
    // rollback do soft-delete
    await supabase.from('sales_orders').update({ deleted_at: null }).eq('id', order.id);
    return { ok: false, stage: 'omie', message: omieErr.message ?? String(omieErr) };
  }
  return { ok: true };
}
```

### `useSalesOrders.deleteOrder` (rewire)

```ts
const deleteOrder = async (order: SalesOrder) => {
  const snapshot = queryClient.getQueryData<SalesOrdersInfiniteCache>(['sales-orders-paginated']);
  queryClient.setQueryData<SalesOrdersInfiniteCache>(['sales-orders-paginated'], (old) =>
    old ? { ...old, pages: old.pages.map((page) => page.filter((o) => o.id !== order.id)) } : old,
  );
  setSelectedIds((prev) => { const next = new Set(prev); next.delete(order.id); return next; });

  const r = await softDeleteOrder(order);
  if (r.ok) { toast.success('Pedido excluído'); return; }
  queryClient.setQueryData(['sales-orders-paginated'], snapshot); // restaura cache
  toast.error('Erro ao excluir pedido', { description: r.message });
};
```

Comportamento idêntico ao atual: supabase-fail → cache restaurado, Omie não chamado; omie-fail → helper já rollbacka `deleted_at`, cache restaurado; ok → toast sucesso.

### `deleteSelected` (bulk) — só limpeza

Remover `as never` das duas linhas de `UPDATE` (`{ deleted_at: nowIso }` e `{ deleted_at: null }`). Nenhuma outra mudança.

## Testing

`src/components/salesOrders/__tests__/soft-delete.test.ts` (mock de `@/integrations/supabase/client`):
- **ok:** update ok + Omie ok → `{ ok: true }`; `functions.invoke` chamado 1×; update chamado 1× (sem rollback).
- **supabase fail:** primeiro update retorna `{ error }` → `{ ok:false, stage:'supabase' }`; Omie **não** chamado.
- **omie fail:** update ok + Omie `{ error }` → `{ ok:false, stage:'omie' }`; update chamado 2× (rollback), o 2º com `{ deleted_at: null }`.

Suíte completa verde; lint limpo; build exit 0.

## Out-of-scope

- UI de ver/restaurar pedidos excluídos (separado; tem o caveat do Omie já excluído).
- Refatorar a lógica de batch do `deleteSelected`.
- Qualquer migration (a coluna/índice já existem).

## Doc

Atualizar CLAUDE.md §10: trocar "SalesOrders.deleteOrder sem soft-delete — exclusão direta no Omie; risco compliance. Precisa migration..." por "✅ entregue (soft-delete `deleted_at` + rollback no Omie-fail + bulk; helper `softDeleteOrder` testado)".
