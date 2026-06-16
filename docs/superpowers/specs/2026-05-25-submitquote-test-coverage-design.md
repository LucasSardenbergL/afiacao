# Cobertura de teste do `submitQuote` — Design Spec

> **Data:** 2026-05-25
> **Status:** aprovado (continuação autônoma decidida com o Codex — irmão do `submitOrder`, próximo na fila de cobertura).
> **Contexto:** `src/services/orderSubmission/submitQuote.ts` (salva carrinho como orçamento — insere `sales_orders` status `orcamento`, **sem sync Omie**) não tem teste. Money-adjacent. Mesma estratégia de mock do `submitOrder` (já coberto em #306).

## Goal

Travar o comportamento do `submitQuote`: validação, sucesso por conta, abort do Oben em falha, não-abort do Colacor em falha, e o invariante de que **orçamento nunca chama o Omie**. Sem mudança de código.

## Comportamentos a travar

1. **Carrinho vazio** (oben+colacor vazios) → `{ success:false, errors:[{step:'validate'}] }`; nenhum insert.
2. **Oben ok** → `success:true`, `results` inclui `'Orçamento Oben salvo'`; insert chamado com `account:'oben'`, `status:'orcamento'`.
3. **Oben insert FALHA → aborta** (`success:false`, `step:'insert_oben_quote'`); se houver Colacor, **o insert do Colacor NÃO é tentado** (early return).
4. **Oben + Colacor ok** → `success:true`, 2 results, 2 inserts.
5. **Colacor FALHA (Oben ok) → NÃO aborta**: `success:true` (Oben salvou), `errors` tem `step:'insert_colacor_quote'`, `results` só o Oben.
6. **Nunca chama `supabase.functions.invoke`** (orçamento não sincroniza com o ERP).

## Mock

- `vi.mock('../helpers')` → `formatCustomerAddress`→`'Rua X'`, `resolveCustomerPhone`→`async '11999'`.
- `vi.mock('@/lib/logger')` → logger no-op.
- **supabase** (injetado): `from('sales_orders').insert(payload)` resolve `{ error }` controlado por `payload.account` (permite Oben-ok + Colacor-falha). `functions.invoke` presente mas **assert never called**.
- Fixtures: reuso do padrão do `submitOrder.test` (OmieCustomer, User, ProductCartItem por `as`).

## Testing

`src/services/orderSubmission/__tests__/submitQuote.test.ts` (vitest). Sem rede. Suíte verde; lint limpo; sem tocar `submitQuote.ts`.

## Out-of-scope

- Refactor; testar helpers (mockados).
