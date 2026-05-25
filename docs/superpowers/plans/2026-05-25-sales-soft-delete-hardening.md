# Soft-delete de pedidos — Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Endurecer o soft-delete de pedidos (já em produção): extrair `softDeleteOrder` testável, rewirar o `deleteOrder` single, remover casts `as never` mortos, corrigir o §10 do CLAUDE.md. Sem migration, sem mudança de comportamento.

**Architecture:** Helper `softDeleteOrder(order)` encapsula UPDATE `deleted_at` + Omie `excluir_pedido` + rollback, retornando um resultado discriminado; o hook `useSalesOrders` mantém cache/toast/seleção e chama o helper. Bulk `deleteSelected` fica intacto (só perde os casts).

**Tech Stack:** React + @tanstack/react-query + Supabase JS + vitest. Helper segue o padrão dos serviços (`picking-confirm.ts`): importa `supabase`, teste mocka o módulo.

**Spec base:** [docs/superpowers/specs/2026-05-25-sales-soft-delete-hardening-design.md](../specs/2026-05-25-sales-soft-delete-hardening-design.md)

**Baseline:** vitest 1016+ passed (main). Não regredir.

---

## File Structure

**Novos:**
```
src/components/salesOrders/soft-delete.ts                  # softDeleteOrder helper
src/components/salesOrders/__tests__/soft-delete.test.ts   # 3 cenários
```

**Editados:**
```
src/components/salesOrders/useSalesOrders.ts   # rewire deleteOrder + remove casts (single + bulk)
CLAUDE.md                                      # §10: marca soft-delete como entregue
```

---

### Task 1: `softDeleteOrder` helper (TDD)

**Files:**
- Create: `src/components/salesOrders/soft-delete.ts`
- Test: `src/components/salesOrders/__tests__/soft-delete.test.ts`

- [ ] **Step 1: Escrever o teste falhando**

Create `src/components/salesOrders/__tests__/soft-delete.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() } },
}));

import { supabase } from '@/integrations/supabase/client';
import { softDeleteOrder } from '../soft-delete';

const mockedFrom = vi.mocked(supabase.from);
const mockedInvoke = vi.mocked(supabase.functions.invoke);

function mockUpdate(eqResult: { error: unknown }) {
  const eqFn = vi.fn().mockResolvedValue(eqResult);
  const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
  mockedFrom.mockReturnValue({ update: updateFn } as never);
  return { updateFn, eqFn };
}

const order = { id: 'ord-1', omie_pedido_id: 42 };

beforeEach(() => {
  mockedFrom.mockReset();
  mockedInvoke.mockReset();
});

describe('softDeleteOrder', () => {
  it('sucesso: soft-delete + Omie ok → { ok: true }, sem rollback', async () => {
    const { updateFn } = mockUpdate({ error: null });
    mockedInvoke.mockResolvedValue({ data: null, error: null } as never);
    const r = await softDeleteOrder(order);
    expect(r).toEqual({ ok: true });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(updateFn).toHaveBeenCalledTimes(1); // só o soft-delete, sem rollback
  });

  it('falha no Supabase: NÃO chama Omie', async () => {
    mockUpdate({ error: { message: 'rls' } });
    const r = await softDeleteOrder(order);
    expect(r).toEqual({ ok: false, stage: 'supabase', message: 'rls' });
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('falha no Omie: rollback (deleted_at=null) + stage omie', async () => {
    const { updateFn } = mockUpdate({ error: null });
    mockedInvoke.mockResolvedValue({ data: null, error: { message: 'omie down' } } as never);
    const r = await softDeleteOrder(order);
    expect(r).toEqual({ ok: false, stage: 'omie', message: 'omie down' });
    expect(updateFn).toHaveBeenCalledTimes(2); // soft-delete + rollback
    expect(updateFn).toHaveBeenLastCalledWith({ deleted_at: null });
  });
});
```

- [ ] **Step 2: Rodar → FAIL**

Run: `bun run vitest run src/components/salesOrders/__tests__/soft-delete.test.ts`
Expected: FAIL — `Cannot find module '../soft-delete'`.

- [ ] **Step 3: Implementar**

Create `src/components/salesOrders/soft-delete.ts`:

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
    await supabase.from('sales_orders').update({ deleted_at: null }).eq('id', order.id);
    return { ok: false, stage: 'omie', message: omieErr.message ?? String(omieErr) };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Rodar → PASS**

Run: `bun run vitest run src/components/salesOrders/__tests__/soft-delete.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/components/salesOrders/soft-delete.ts src/components/salesOrders/__tests__/soft-delete.test.ts
git commit -m "feat(sales): extrai softDeleteOrder testável (soft-delete + Omie + rollback, 3 tests)"
```

---

### Task 2: Rewire `deleteOrder` (single) pra usar o helper

**Files:**
- Modify: `src/components/salesOrders/useSalesOrders.ts`

- [ ] **Step 1: Import do helper**

Adicionar após o import de `./types` (linha ~21):
```ts
import { softDeleteOrder } from './soft-delete';
```

- [ ] **Step 2: Substituir o `deleteOrder` inteiro**

Trocar o bloco atual (do comentário `// Soft-delete + Omie exclude. Fluxo:` até o fechamento `};` do `deleteOrder`, linhas ~147-205) por:

```ts
  // Soft-delete + Omie exclude. Cache/toast aqui; orquestração no helper softDeleteOrder.
  // 1. Optimistic remove do cache. 2. softDeleteOrder (deleted_at + Omie + rollback).
  // 3. Em falha, restaura o cache (helper já reverteu deleted_at quando o Omie falha).
  const deleteOrder = async (order: SalesOrder) => {
    const snapshot = queryClient.getQueryData<SalesOrdersInfiniteCache>(['sales-orders-paginated']);
    queryClient.setQueryData<SalesOrdersInfiniteCache>(['sales-orders-paginated'], (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => page.filter((o) => o.id !== order.id)),
      };
    });
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(order.id);
      return next;
    });

    const result = await softDeleteOrder(order);
    if (result.ok) {
      toast.success('Pedido excluído');
      return;
    }
    queryClient.setQueryData(['sales-orders-paginated'], snapshot);
    toast.error('Erro ao excluir pedido', { description: result.message });
  };
```

> Comportamento idêntico: `stage:'supabase'` → o helper não chamou o Omie; `stage:'omie'` → o helper já reverteu `deleted_at`; aqui só restauramos o cache e mostramos o toast. O `console.error` foi removido (o toast já comunica; o helper retorna a mensagem).

- [ ] **Step 3: Lint + tests**

Run:
```bash
bunx eslint src/components/salesOrders/useSalesOrders.ts
bun run vitest run src/components/salesOrders/__tests__/soft-delete.test.ts
```
Expected: zero erros de lint (incluindo nenhum import órfão); 3/3.

- [ ] **Step 4: Commit**

```bash
git add src/components/salesOrders/useSalesOrders.ts
git commit -m "refactor(sales): deleteOrder usa softDeleteOrder (remove cast as never morto)"
```

---

### Task 3: Remover casts `as never` mortos do bulk `deleteSelected`

**Files:**
- Modify: `src/components/salesOrders/useSalesOrders.ts`

- [ ] **Step 1: Remover `as never` das duas linhas de UPDATE do bulk**

Trocar (no `deleteSelected`, soft-delete em batch):
```ts
      .update({ deleted_at: nowIso } as never)
```
por:
```ts
      .update({ deleted_at: nowIso })
```

E trocar (rollback parcial do bulk):
```ts
        .update({ deleted_at: null } as never)
```
por:
```ts
        .update({ deleted_at: null })
```

> O tipo `Update` de `sales_orders` já tem `deleted_at?: string | null` — os casts eram dead-weight (comentário "ainda não no generated type" estava obsoleto). Nenhuma outra mudança no bulk.

- [ ] **Step 2: Typecheck + lint**

Run:
```bash
bunx tsc --noEmit 2>&1 | grep -i "useSalesOrders\|soft-delete" || echo "sem erros nos arquivos tocados"
bunx eslint src/components/salesOrders/useSalesOrders.ts
```
Expected: sem erros de tipo nos arquivos tocados (o `.update({ deleted_at })` tipado compila); lint limpo.

- [ ] **Step 3: Commit**

```bash
git add src/components/salesOrders/useSalesOrders.ts
git commit -m "chore(sales): remove casts 'as never' mortos do bulk delete (tipo já tem deleted_at)"
```

---

### Task 4: Corrigir CLAUDE.md §10 + validação final

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Atualizar a nota do §10**

Em `CLAUDE.md`, localizar a linha do §10 que começa com `- **SalesOrders.deleteOrder sem soft-delete**` e trocá-la por:

```markdown
- ✅ **SalesOrders.deleteOrder — soft-delete entregue**: coluna `deleted_at` + partial index `idx_sales_orders_active` (filtro `deleted_at IS NULL` na lista), optimistic remove + rollback quando o Omie falha, versão bulk com rollback parcial. Orquestração single extraída em `src/components/salesOrders/soft-delete.ts` (`softDeleteOrder`, testado). Não há UI de ver/restaurar excluídos (a recuperação é parcial — o PV no Omie já foi excluído); fica como follow-up se houver demanda.
```

> Se o texto exato divergir, ajustar pra remover a afirmação de que falta soft-delete/migration e refletir o estado entregue.

- [ ] **Step 2: Suíte + lint + build completos**

Run:
```bash
bun run test
bun lint
bun run build
```
Expected: vitest verde (1016 + 3 novos); lint sem erros novos nos arquivos tocados; build exit 0.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): §10 marca soft-delete de pedidos como entregue"
```

- [ ] **Step 4: Push + PR (com ok do founder)**

```bash
git push -u origin claude/sales-soft-delete-hardening
```
PR title: `refactor(sales): endurece soft-delete (helper testável + cleanup de casts)`

---

## Critérios de "feito"

- [ ] `softDeleteOrder` testado (sucesso sem rollback; supabase-fail não chama Omie; omie-fail rollbacka `deleted_at=null`).
- [ ] `deleteOrder` single usa o helper; comportamento idêntico (cache/toast preservados).
- [ ] Casts `as never` removidos (single via helper + bulk).
- [ ] CLAUDE.md §10 reflete o soft-delete entregue.
- [ ] vitest verde; lint sem erros novos; build exit 0; sem migration.

## Out-of-scope

- UI de ver/restaurar pedidos excluídos.
- Refatorar a lógica de batch do `deleteSelected`.
