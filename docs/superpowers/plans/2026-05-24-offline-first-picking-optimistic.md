# Offline-First Picking + Optimistic UI + Fix de Handler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o picking de chão de fábrica offline-capaz (mutação `picking.confirm-item` idempotente + feedback optimista <100ms), e consertar o bug latente em que handlers de flush registrados por página deixam mutações presas na fila.

**Architecture:** Mutação nova absolute-state idempotente (evento com `id` cliente como chave anti-replay). Optimistic via "fila-como-overlay": o estado pendente vive na fila offline (localStorage) e é mesclado sobre as linhas do servidor na renderização — sobrevive a refetch do `NetworkFirst` e a reload do PWA, sem double-apply (o flush escreve só no servidor). Handlers de flush centralizados no boot do AppShell.

**Tech Stack:** React 18 + TypeScript + @tanstack/react-query + Supabase JS + vitest + offline-queue.ts/useOfflineMutation/useOfflineFlush (já existentes).

**Spec base:** [docs/superpowers/specs/2026-05-24-offline-first-picking-optimistic-design.md](../specs/2026-05-24-offline-first-picking-optimistic-design.md)

**Baseline:** vitest 686 passed / 122 files (confirmado 2026-05-24). Não regredir.

---

## File Structure

**Novos arquivos:**
```
src/services/picking-confirm.ts                       # confirmPickItem(vars) idempotente
src/services/__tests__/picking-confirm.test.ts        # 4 cenários
src/lib/picking/optimistic-merge.ts                   # applyQueuedPickConfirms (puro)
src/lib/picking/__tests__/optimistic-merge.test.ts    # merge last-wins
src/lib/offline-handlers.ts                           # registerAllOfflineHandlers() central
src/lib/__tests__/offline-handlers.test.ts            # registra os 4 kinds
src/components/picking/PickItemConfirmCard.tsx        # card de confirmar item (+ divergência)
src/components/picking/__tests__/PickItemConfirmCard.test.tsx  # gating de justificativa
```

**Arquivos editados:**
```
src/lib/offline-queue.ts                # + getQueuedByKind()
src/components/AppShell.tsx             # importa useEffect + registerAllOfflineHandlers (boot)
src/pages/RecebimentoConferencia.tsx    # remove os 3 registerOfflineHandler por-página (fix do bug)
src/pages/picking/TouchPickingView.tsx  # ActiveTaskView usa confirm + optimistic merge
CLAUDE.md                               # §6/§9b refletindo estado real (não-bloqueante)
```

---

# Phase 1 · Serviço de picking (idempotente)

### Task 1: `confirmPickItem` service (TDD)

**Files:**
- Create: `src/services/picking-confirm.ts`
- Test: `src/services/__tests__/picking-confirm.test.ts`

- [ ] **Step 1: Escrever o teste falhando**

Create `src/services/__tests__/picking-confirm.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn() },
}));

import { supabase } from '@/integrations/supabase/client';
import { confirmPickItem, type ConfirmPickItemVars } from '../picking-confirm';

const mockedFrom = vi.mocked(supabase.from);

/** Monta um mock de `supabase.from` que discrimina por tabela. */
function mockSupabase(opts: {
  insertResult?: { error: unknown };
  updateResult?: { error: unknown };
}) {
  const insertFn = vi.fn().mockResolvedValue(opts.insertResult ?? { error: null });
  const eqFn = vi.fn().mockResolvedValue(opts.updateResult ?? { error: null });
  const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
  mockedFrom.mockImplementation((table: string) => {
    if (table === 'picking_events') return { insert: insertFn } as never;
    return { update: updateFn } as never;
  });
  return { insertFn, updateFn, eqFn };
}

const baseVars: ConfirmPickItemVars = {
  eventId: 'evt-1',
  pickingTaskId: 'task-1',
  pickingTaskItemId: 'item-1',
  userId: 'user-1',
  quantidade: 10,
  quantidadeSeparada: 10,
  loteEsperado: 'LOTE-A',
  loteInformado: 'LOTE-A',
  justificativa: null,
  confirmedAt: '2026-05-24T12:00:00.000Z',
};

beforeEach(() => mockedFrom.mockReset());

describe('confirmPickItem', () => {
  it('confirma cheio com lote correto: evento item_confirmado + update absoluto status concluido', async () => {
    const { insertFn, updateFn, eqFn } = mockSupabase({});
    const r = await confirmPickItem(baseVars);
    expect(r).toEqual({ ok: true });
    expect(insertFn).toHaveBeenCalledWith(expect.objectContaining({
      id: 'evt-1', event_type: 'item_confirmado', picking_task_item_id: 'item-1', user_id: 'user-1',
    }));
    expect(updateFn).toHaveBeenCalledWith(expect.objectContaining({
      quantidade_separada: 10, status: 'concluido', lote_separado: 'LOTE-A', separado_at: '2026-05-24T12:00:00.000Z',
    }));
    expect(eqFn).toHaveBeenCalledWith('id', 'item-1');
  });

  it('replay (PK 23505 no insert) NÃO lança e ainda roda o update', async () => {
    const { updateFn } = mockSupabase({ insertResult: { error: { code: '23505', message: 'dup' } } });
    const r = await confirmPickItem(baseVars);
    expect(r).toEqual({ ok: true });
    expect(updateFn).toHaveBeenCalled();
  });

  it('lote divergente exige tipo lote_divergente', async () => {
    const { insertFn } = mockSupabase({});
    await confirmPickItem({ ...baseVars, loteInformado: 'LOTE-B', justificativa: 'lote A esgotado' });
    expect(insertFn).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'lote_divergente' }));
  });

  it('separação parcial deriva status em_andamento', async () => {
    const { updateFn } = mockSupabase({});
    await confirmPickItem({ ...baseVars, quantidadeSeparada: 4 });
    expect(updateFn).toHaveBeenCalledWith(expect.objectContaining({ quantidade_separada: 4, status: 'em_andamento' }));
  });

  it('erro não-23505 no insert propaga', async () => {
    mockSupabase({ insertResult: { error: { code: '42501', message: 'rls' } } });
    await expect(confirmPickItem(baseVars)).rejects.toMatchObject({ code: '42501' });
  });
});
```

- [ ] **Step 2: Rodar o teste → FAIL (módulo não existe)**

Run: `bun run vitest run src/services/__tests__/picking-confirm.test.ts`
Expected: FAIL — `Cannot find module '../picking-confirm'`.

- [ ] **Step 3: Implementar o serviço**

Create `src/services/picking-confirm.ts`:

```ts
import { supabase } from '@/integrations/supabase/client';

export interface ConfirmPickItemVars {
  /** crypto.randomUUID() gerado no bipe — chave de idempotência do evento. */
  eventId: string;
  pickingTaskId: string;
  pickingTaskItemId: string;
  userId: string | null;
  /** Quantidade esperada do item (pra derivar status). */
  quantidade: number;
  /** Quantidade separada ABSOLUTA (nunca incremento). */
  quantidadeSeparada: number;
  loteEsperado: string | null;
  loteInformado: string | null;
  justificativa: string | null;
  /** ISO timestamp. */
  confirmedAt: string;
}

/**
 * Confirma a separação de um item de picking. Idempotente o suficiente pra
 * replay offline-then-online:
 *  - evento de auditoria usa `id = eventId` (PK) como chave anti-replay; 23505 = já aplicado.
 *  - UPDATE do item usa valores ABSOLUTOS (rodar 2x com mesmo payload não superconta).
 */
export async function confirmPickItem(vars: ConfirmPickItemVars): Promise<{ ok: true }> {
  const divergente =
    vars.loteInformado != null &&
    vars.loteEsperado != null &&
    vars.loteInformado !== vars.loteEsperado;
  const eventType = divergente ? 'lote_divergente' : 'item_confirmado';

  const { error: e1 } = await supabase.from('picking_events').insert({
    id: vars.eventId,
    picking_task_id: vars.pickingTaskId,
    picking_task_item_id: vars.pickingTaskItemId,
    event_type: eventType,
    lote_esperado: vars.loteEsperado,
    lote_informado: vars.loteInformado,
    justificativa: vars.justificativa,
    user_id: vars.userId,
  });
  // 23505 = unique_violation (replay do mesmo eventId) → idempotente, segue.
  if (e1 && (e1 as { code?: string }).code !== '23505') throw e1;

  const status = vars.quantidadeSeparada >= vars.quantidade ? 'concluido' : 'em_andamento';
  const { error: e2 } = await supabase
    .from('picking_task_items')
    .update({
      quantidade_separada: vars.quantidadeSeparada,
      status,
      lote_separado: vars.loteInformado,
      justificativa_substituicao: vars.justificativa,
      separado_at: vars.confirmedAt,
    })
    .eq('id', vars.pickingTaskItemId);
  if (e2) throw e2;

  return { ok: true };
}
```

- [ ] **Step 4: Rodar o teste → PASS**

Run: `bun run vitest run src/services/__tests__/picking-confirm.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/services/picking-confirm.ts src/services/__tests__/picking-confirm.test.ts
git commit -m "feat(picking): confirmPickItem service idempotente (absolute-state + evento anti-replay, 5 tests)"
```

---

# Phase 2 · Optimistic — fila-como-overlay

### Task 2: `getQueuedByKind` em offline-queue (TDD)

**Files:**
- Modify: `src/lib/offline-queue.ts`
- Test: `src/lib/__tests__/offline-queue-by-kind.test.ts`

- [ ] **Step 1: Escrever o teste falhando**

Create `src/lib/__tests__/offline-queue-by-kind.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

// track() chama analytics/posthog — neutraliza no teste.
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { getQueuedByKind } from '../offline-queue';

const STORAGE_KEY = 'offline_queue_v1';

beforeEach(() => localStorage.clear());

describe('getQueuedByKind', () => {
  it('retorna [] quando a fila está vazia', () => {
    expect(getQueuedByKind('picking.confirm-item')).toEqual([]);
  });

  it('filtra por kind', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { id: '1', kind: 'picking.confirm-item', variables: { a: 1 }, enqueuedAt: 'x', attempts: 0 },
      { id: '2', kind: 'recebimento.confirm-unit', variables: { b: 2 }, enqueuedAt: 'x', attempts: 0 },
      { id: '3', kind: 'picking.confirm-item', variables: { a: 3 }, enqueuedAt: 'x', attempts: 0 },
    ]));
    const r = getQueuedByKind<{ a: number }>('picking.confirm-item');
    expect(r).toHaveLength(2);
    expect(r.map((q) => q.variables.a)).toEqual([1, 3]);
  });

  it('tolera localStorage corrompido', () => {
    localStorage.setItem(STORAGE_KEY, '{nope');
    expect(getQueuedByKind('picking.confirm-item')).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar → FAIL**

Run: `bun run vitest run src/lib/__tests__/offline-queue-by-kind.test.ts`
Expected: FAIL — `getQueuedByKind is not a function`.

- [ ] **Step 3: Implementar**

Em `src/lib/offline-queue.ts`, adicionar após a função `getOfflineQueueDepth` (que termina por volta da linha 83):

```ts
/** Retorna as mutações enfileiradas de um determinado kind (na ordem de enfileiramento). */
export function getQueuedByKind<TVars = unknown>(kind: string): QueuedMutation<TVars>[] {
  return readQueue().filter((m): m is QueuedMutation<TVars> => m.kind === kind);
}
```

(`readQueue` já é privado no mesmo módulo e tolera JSON corrompido.)

- [ ] **Step 4: Rodar → PASS**

Run: `bun run vitest run src/lib/__tests__/offline-queue-by-kind.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/lib/offline-queue.ts src/lib/__tests__/offline-queue-by-kind.test.ts
git commit -m "feat(offline): getQueuedByKind para o overlay optimista (3 tests)"
```

---

### Task 3: `applyQueuedPickConfirms` helper puro (TDD)

**Files:**
- Create: `src/lib/picking/optimistic-merge.ts`
- Test: `src/lib/picking/__tests__/optimistic-merge.test.ts`

- [ ] **Step 1: Escrever o teste falhando**

Create `src/lib/picking/__tests__/optimistic-merge.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applyQueuedPickConfirms } from '../optimistic-merge';
import type { ConfirmPickItemVars } from '@/services/picking-confirm';

type Row = {
  id: string;
  quantidade: number;
  quantidade_separada: number;
  status: string;
  lote_separado: string | null;
  separado_at: string | null;
};

const server: Row[] = [
  { id: 'a', quantidade: 10, quantidade_separada: 0, status: 'pendente', lote_separado: null, separado_at: null },
  { id: 'b', quantidade: 5, quantidade_separada: 0, status: 'pendente', lote_separado: null, separado_at: null },
];

function pend(itemId: string, qtd: number, lote: string | null, at: string): ConfirmPickItemVars {
  return {
    eventId: 'e', pickingTaskId: 't', pickingTaskItemId: itemId, userId: null,
    quantidade: 0, quantidadeSeparada: qtd, loteEsperado: null, loteInformado: lote, justificativa: null, confirmedAt: at,
  };
}

describe('applyQueuedPickConfirms', () => {
  it('sobrepõe item com confirm pendente e marca pendingIds', () => {
    const { items, pendingIds } = applyQueuedPickConfirms(server, [pend('a', 10, 'L1', 'T1')]);
    const a = items.find((i) => i.id === 'a')!;
    expect(a.quantidade_separada).toBe(10);
    expect(a.status).toBe('concluido');
    expect(a.lote_separado).toBe('L1');
    expect(a.separado_at).toBe('T1');
    expect(pendingIds.has('a')).toBe(true);
    expect(pendingIds.has('b')).toBe(false);
  });

  it('item sem pendente fica intacto', () => {
    const { items } = applyQueuedPickConfirms(server, [pend('a', 10, 'L1', 'T1')]);
    expect(items.find((i) => i.id === 'b')).toEqual(server[1]);
  });

  it('parcial deriva em_andamento', () => {
    const { items } = applyQueuedPickConfirms(server, [pend('b', 2, null, 'T1')]);
    expect(items.find((i) => i.id === 'b')!.status).toBe('em_andamento');
  });

  it('dois confirms pro mesmo item: o último da fila vence', () => {
    const { items } = applyQueuedPickConfirms(server, [pend('a', 3, 'L1', 'T1'), pend('a', 10, 'L2', 'T2')]);
    const a = items.find((i) => i.id === 'a')!;
    expect(a.quantidade_separada).toBe(10);
    expect(a.lote_separado).toBe('L2');
  });
});
```

- [ ] **Step 2: Rodar → FAIL**

Run: `bun run vitest run src/lib/picking/__tests__/optimistic-merge.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

Create `src/lib/picking/optimistic-merge.ts`:

```ts
import type { ConfirmPickItemVars } from '@/services/picking-confirm';

/** Campos mínimos que o merge precisa numa linha de picking_task_items. */
interface MergeableItem {
  id: string;
  quantidade: number;
  quantidade_separada: number;
  status: string;
  lote_separado: string | null;
  separado_at: string | null;
}

/**
 * Mescla confirms de picking enfileirados (offline) sobre as linhas do servidor.
 * Valores ABSOLUTOS; quando há mais de um pendente pro mesmo item, o último da fila vence.
 * Retorna a lista mesclada (tipo inalterado) + os ids com sync pendente.
 */
export function applyQueuedPickConfirms<T extends MergeableItem>(
  serverItems: T[],
  queued: ConfirmPickItemVars[],
): { items: T[]; pendingIds: Set<string> } {
  const byItem = new Map<string, ConfirmPickItemVars>();
  for (const q of queued) byItem.set(q.pickingTaskItemId, q); // ordem de enfileiramento → último vence
  const pendingIds = new Set<string>();
  const items = serverItems.map((it) => {
    const p = byItem.get(it.id);
    if (!p) return it;
    pendingIds.add(it.id);
    return {
      ...it,
      quantidade_separada: p.quantidadeSeparada,
      status: p.quantidadeSeparada >= it.quantidade ? 'concluido' : 'em_andamento',
      lote_separado: p.loteInformado,
      separado_at: p.confirmedAt,
    };
  });
  return { items, pendingIds };
}
```

- [ ] **Step 4: Rodar → PASS**

Run: `bun run vitest run src/lib/picking/__tests__/optimistic-merge.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/lib/picking/optimistic-merge.ts src/lib/picking/__tests__/optimistic-merge.test.ts
git commit -m "feat(picking): applyQueuedPickConfirms (overlay fila-sobre-servidor, last-wins, 4 tests)"
```

---

# Phase 3 · Fix do bug — registro central de handlers

### Task 4: `registerAllOfflineHandlers` (TDD)

**Files:**
- Create: `src/lib/offline-handlers.ts`
- Test: `src/lib/__tests__/offline-handlers.test.ts`

- [ ] **Step 1: Escrever o teste falhando**

Create `src/lib/__tests__/offline-handlers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/hooks/useOfflineFlush', () => ({
  registerOfflineHandler: vi.fn(() => () => {}),
}));
vi.mock('@/services/recebimento-confirm', () => ({ confirmUnit: vi.fn() }));
vi.mock('@/services/recebimento-divergencia', () => ({ reportDivergencia: vi.fn() }));
vi.mock('@/services/recebimento-cte', () => ({ addCte: vi.fn() }));
vi.mock('@/services/picking-confirm', () => ({ confirmPickItem: vi.fn() }));

import { registerOfflineHandler } from '@/hooks/useOfflineFlush';
import { registerAllOfflineHandlers } from '../offline-handlers';

const mockedRegister = vi.mocked(registerOfflineHandler);

beforeEach(() => mockedRegister.mockClear());

describe('registerAllOfflineHandlers', () => {
  it('registra os 4 kinds offline', () => {
    registerAllOfflineHandlers();
    const kinds = mockedRegister.mock.calls.map((c) => c[0]);
    expect(kinds).toEqual(expect.arrayContaining([
      'recebimento.confirm-unit',
      'recebimento.report-divergencia',
      'recebimento.add-cte',
      'picking.confirm-item',
    ]));
    expect(mockedRegister).toHaveBeenCalledTimes(4);
  });

  it('a cleanup desregistra todos', () => {
    const unregs = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    let i = 0;
    mockedRegister.mockImplementation(() => unregs[i++]);
    const cleanup = registerAllOfflineHandlers();
    cleanup();
    unregs.forEach((u) => expect(u).toHaveBeenCalledTimes(1));
  });
});
```

- [ ] **Step 2: Rodar → FAIL**

Run: `bun run vitest run src/lib/__tests__/offline-handlers.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

Create `src/lib/offline-handlers.ts`:

```ts
import { registerOfflineHandler } from '@/hooks/useOfflineFlush';
import { confirmUnit, type ConfirmUnitVars } from '@/services/recebimento-confirm';
import { reportDivergencia, type ReportDivergenciaVars } from '@/services/recebimento-divergencia';
import { addCte, type AddCteVars } from '@/services/recebimento-cte';
import { confirmPickItem, type ConfirmPickItemVars } from '@/services/picking-confirm';

/**
 * Registra TODOS os handlers de flush por kind, uma única vez, no boot do app.
 *
 * Por que central (e não por página): os handlers eram registrados dentro de
 * RecebimentoConferencia e desregistravam no unmount — se o conferente confirmava
 * offline e saía da página, o flush ao reconectar não achava handler e o item
 * ficava preso na fila. Registrando no boot, reconectar em QUALQUER tela drena a fila.
 *
 * Retorna uma cleanup que desregistra todos.
 */
export function registerAllOfflineHandlers(): () => void {
  const unsubs = [
    registerOfflineHandler<ConfirmUnitVars>('recebimento.confirm-unit', async (v) => {
      await confirmUnit(v);
      return true;
    }),
    registerOfflineHandler<ReportDivergenciaVars>('recebimento.report-divergencia', async (v) => {
      await reportDivergencia(v);
      return true;
    }),
    registerOfflineHandler<AddCteVars>('recebimento.add-cte', async (v) => {
      await addCte(v);
      return true;
    }),
    registerOfflineHandler<ConfirmPickItemVars>('picking.confirm-item', async (v) => {
      await confirmPickItem(v);
      return true;
    }),
  ];
  return () => unsubs.forEach((u) => u());
}
```

- [ ] **Step 4: Rodar → PASS**

Run: `bun run vitest run src/lib/__tests__/offline-handlers.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add src/lib/offline-handlers.ts src/lib/__tests__/offline-handlers.test.ts
git commit -m "feat(offline): registerAllOfflineHandlers central (2 tests)"
```

---

### Task 5: Montar no AppShell + remover registros por-página do Recebimento

**Files:**
- Modify: `src/components/AppShell.tsx`
- Modify: `src/pages/RecebimentoConferencia.tsx`

- [ ] **Step 1: AppShell — importar `useEffect` e `registerAllOfflineHandlers`**

Em `src/components/AppShell.tsx` linha 1, trocar:

```ts
import React, { useState } from 'react';
```
por:
```ts
import React, { useState, useEffect } from 'react';
```

Adicionar com os outros imports (ex. logo após a linha 40 `import { useRouteTracker } from '@/lib/dashboard/route-tracker';`):

```ts
import { registerAllOfflineHandlers } from '@/lib/offline-handlers';
```

- [ ] **Step 2: AppShell — registrar no boot ANTES de `useOfflineFlush()`**

No corpo de `export function AppShell({ children })` (por volta da linha 731-733), trocar:

```ts
export function AppShell({ children }: { children: React.ReactNode }) {
  useRouteTracker();
  useOfflineFlush();
```
por:
```ts
export function AppShell({ children }: { children: React.ReactNode }) {
  useRouteTracker();
  // Registra os handlers de flush ANTES do useOfflineFlush (que pode disparar flush no mount).
  useEffect(() => registerAllOfflineHandlers(), []);
  useOfflineFlush();
```

> A ordem importa: o effect de registro é declarado antes do `useOfflineFlush()`, então roda primeiro no mount — os handlers existem antes de qualquer flush.

- [ ] **Step 3: RecebimentoConferencia — remover o import e os 3 useEffect de registro**

Em `src/pages/RecebimentoConferencia.tsx`:

(a) remover a linha 27:
```ts
import { registerOfflineHandler } from '@/hooks/useOfflineFlush';
```

(b) remover o bloco dos três `useEffect` de registro (por volta das linhas 181-205), que começa com o comentário `// Registra handler pra processar items enfileirados quando reconectar` e termina no fechamento do terceiro `useEffect` de `recebimento.add-cte`:

```ts
  // Registra handler pra processar items enfileirados quando reconectar
  useEffect(() => {
    return registerOfflineHandler<ConfirmUnitVars>('recebimento.confirm-unit', async (vars) => {
      await confirmUnit(vars);
      return true;
    });
  }, []);

  useEffect(() => {
    return registerOfflineHandler<ReportDivergenciaVars>('recebimento.report-divergencia', async (vars) => {
      await reportDivergencia(vars);
      return true;
    });
  }, []);

  useEffect(() => {
    return registerOfflineHandler<AddCteVars>('recebimento.add-cte', async (vars) => {
      await addCte(vars);
      return true;
    });
  }, []);
```

> Manter os `useOfflineMutation` (`confirmMutation`/`divergenciaMutation`/`addCteMutation`) e os imports de `confirmUnit`/`reportDivergencia`/`addCte` (ainda usados como `mutationFn`). Só sai o `registerOfflineHandler` e os 3 effects. Os tipos `ConfirmUnitVars`/`ReportDivergenciaVars`/`AddCteVars` continuam importados (usados nos `useOfflineMutation`).

- [ ] **Step 4: Validar lint + suíte completa**

Run:
```bash
bunx eslint src/components/AppShell.tsx src/pages/RecebimentoConferencia.tsx
bun run vitest run
```
Expected: zero erros de lint novos; vitest verde (686 + novos de Tasks 1-4).

- [ ] **Step 5: Commit**

```bash
git add src/components/AppShell.tsx src/pages/RecebimentoConferencia.tsx
git commit -m "fix(offline): centraliza registro de handlers no boot (conserta item preso ao sair do recebimento)"
```

---

# Phase 4 · UI de picking + optimistic

### Task 6: `PickItemConfirmCard` (TDD — gating de justificativa)

**Files:**
- Create: `src/components/picking/PickItemConfirmCard.tsx`
- Test: `src/components/picking/__tests__/PickItemConfirmCard.test.tsx`

- [ ] **Step 1: Escrever o teste falhando**

Create `src/components/picking/__tests__/PickItemConfirmCard.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PickItemConfirmCard, type PickItem } from '../PickItemConfirmCard';

const item: PickItem = {
  id: 'item-1',
  product_descricao: 'Lixa 120',
  quantidade: 10,
  quantidade_separada: 0,
  status: 'pendente',
  lote_fefo: 'LOTE-A',
  lote_separado: null,
};

describe('PickItemConfirmCard', () => {
  it('confirma cheio com lote FEFO no caminho rápido', () => {
    const onConfirm = vi.fn();
    render(<PickItemConfirmCard item={item} pending={false} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: /confirmar separação/i }));
    expect(onConfirm).toHaveBeenCalledWith({
      quantidadeSeparada: 10,
      loteInformado: 'LOTE-A',
      justificativa: null,
    });
  });

  it('na divergência de lote, exige justificativa pra habilitar o confirmar', () => {
    const onConfirm = vi.fn();
    render(<PickItemConfirmCard item={item} pending={false} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: /divergência/i }));

    // Muda o lote pra um diferente do FEFO → vira divergência
    fireEvent.change(screen.getByLabelText(/lote separado/i), { target: { value: 'LOTE-B' } });

    const confirmDiv = screen.getByRole('button', { name: /confirmar com divergência/i });
    expect(confirmDiv).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/justificativa/i), { target: { value: 'lote A esgotado' } });
    expect(confirmDiv).toBeEnabled();

    fireEvent.click(confirmDiv);
    expect(onConfirm).toHaveBeenCalledWith({
      quantidadeSeparada: 10,
      loteInformado: 'LOTE-B',
      justificativa: 'lote A esgotado',
    });
  });

  it('mostra badge pendente quando pending=true', () => {
    render(<PickItemConfirmCard item={item} pending onConfirm={vi.fn()} />);
    expect(screen.getByText(/pendente sync/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Rodar → FAIL**

Run: `bun run vitest run src/components/picking/__tests__/PickItemConfirmCard.test.tsx`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

Create `src/components/picking/PickItemConfirmCard.tsx`:

```tsx
import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Check, AlertTriangle, CloudUpload } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PickItem {
  id: string;
  product_descricao: string | null;
  quantidade: number;
  quantidade_separada: number;
  status: string;
  lote_fefo: string | null;
  lote_separado: string | null;
}

export interface ConfirmPayload {
  quantidadeSeparada: number;
  loteInformado: string | null;
  justificativa: string | null;
}

interface Props {
  item: PickItem;
  pending: boolean;
  onConfirm: (payload: ConfirmPayload) => void;
  disabled?: boolean;
}

export function PickItemConfirmCard({ item, pending, onConfirm, disabled }: Props) {
  const concluido = item.status === 'concluido' || item.quantidade_separada >= item.quantidade;
  const [mode, setMode] = useState<'idle' | 'divergencia'>('idle');
  const [qtd, setQtd] = useState<number>(item.quantidade);
  const [lote, setLote] = useState<string>(item.lote_fefo ?? '');
  const [justificativa, setJustificativa] = useState('');

  const isDivergente =
    qtd !== item.quantidade || (lote || null) !== (item.lote_fefo ?? null);
  const justObrigatoria = isDivergente && justificativa.trim().length === 0;

  const confirmFull = () =>
    onConfirm({ quantidadeSeparada: item.quantidade, loteInformado: item.lote_fefo, justificativa: null });

  const confirmDiv = () =>
    onConfirm({
      quantidadeSeparada: qtd,
      loteInformado: lote || null,
      justificativa: justificativa.trim() || null,
    });

  return (
    <Card className={cn(concluido && !pending && 'opacity-50')}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-base font-medium leading-snug">{item.product_descricao}</p>
          <div className="flex items-center gap-1 shrink-0">
            {pending && (
              <Badge variant="outline" className="text-[10px] gap-1 bg-status-info-bg text-status-info-bold border-status-info-bold/30">
                <CloudUpload className="w-3 h-3" /> pendente sync
              </Badge>
            )}
            {concluido && <Check className="w-5 h-5 text-status-success" />}
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="outline" className="text-xs">{item.quantidade_separada} de {item.quantidade}</Badge>
          {item.lote_fefo && <Badge variant="outline" className="text-xs font-mono">FEFO: {item.lote_fefo}</Badge>}
        </div>

        {mode === 'idle' ? (
          <div className="flex gap-2">
            <Button size="touch" className="flex-1" onClick={confirmFull} disabled={disabled}>
              Confirmar separação
            </Button>
            <Button size="touch" variant="outline" onClick={() => setMode('divergencia')} disabled={disabled}>
              Divergência
            </Button>
          </div>
        ) : (
          <div className="space-y-3 border-t border-border pt-3">
            <div className="space-y-1">
              <Label htmlFor={`qtd-${item.id}`}>Quantidade separada</Label>
              <Input
                id={`qtd-${item.id}`}
                type="number"
                inputMode="numeric"
                value={qtd}
                onChange={(e) => setQtd(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`lote-${item.id}`}>Lote separado</Label>
              <Input id={`lote-${item.id}`} value={lote} onChange={(e) => setLote(e.target.value)} className="font-mono" />
            </div>
            {isDivergente && (
              <div className="space-y-1">
                <Label htmlFor={`just-${item.id}`} className="flex items-center gap-1 text-status-warning-bold">
                  <AlertTriangle className="w-3 h-3" /> Justificativa
                </Label>
                <Textarea
                  id={`just-${item.id}`}
                  value={justificativa}
                  onChange={(e) => setJustificativa(e.target.value)}
                  placeholder="Por que divergiu do FEFO / da quantidade?"
                  rows={2}
                />
              </div>
            )}
            <div className="flex gap-2">
              <Button size="touch" className="flex-1" onClick={confirmDiv} disabled={disabled || justObrigatoria}>
                Confirmar com divergência
              </Button>
              <Button size="touch" variant="ghost" onClick={() => setMode('idle')} disabled={disabled}>
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Rodar → PASS**

Run: `bun run vitest run src/components/picking/__tests__/PickItemConfirmCard.test.tsx`
Expected: PASS (3/3).

> Se `@/components/ui/textarea` ou `@/components/ui/label` não existirem, confira com `ls src/components/ui/textarea.tsx src/components/ui/label.tsx` — ambos são shadcn padrão e devem existir. Se faltar algum, troque por `<textarea className="...">`/`<label>` nativo.

- [ ] **Step 5: Commit**

```bash
git add src/components/picking/PickItemConfirmCard.tsx src/components/picking/__tests__/PickItemConfirmCard.test.tsx
git commit -m "feat(picking): PickItemConfirmCard com gating de justificativa em divergência FEFO (3 tests)"
```

---

### Task 7: Fiar confirm + optimistic no `TouchPickingView.ActiveTaskView`

**Files:**
- Modify: `src/pages/picking/TouchPickingView.tsx`

- [ ] **Step 1: Imports + ampliar o tipo/SELECT da linha de item**

No topo de `src/pages/picking/TouchPickingView.tsx`, adicionar aos imports existentes:

```ts
import { useEffect, useState, useMemo } from 'react'; // 'useState' já existe — garantir 'useEffect' e 'useMemo'
import { useQueryClient } from '@tanstack/react-query'; // junto do useQuery existente
import { toast } from 'sonner'; // já existe
import { useAuth } from '@/contexts/AuthContext';
import { useOfflineMutation } from '@/hooks/useOfflineMutation';
import { confirmPickItem, type ConfirmPickItemVars } from '@/services/picking-confirm';
import { getQueuedByKind, subscribeToOfflineQueue } from '@/lib/offline-queue';
import { applyQueuedPickConfirms } from '@/lib/picking/optimistic-merge';
import { PickItemConfirmCard, type ConfirmPayload } from '@/components/picking/PickItemConfirmCard';
```

> Consolidar com os imports já presentes (`useQuery`, `useState`, `toast`, etc.) pra não duplicar.

Ampliar o tipo `PickingTaskItemRow` (linhas ~15-18) pra incluir `separado_at` (o merge optimista o sobrepõe):

```ts
type PickingTaskItemRow = Pick<
  Tables<'picking_task_items'>,
  'id' | 'product_descricao' | 'quantidade' | 'quantidade_separada' | 'status' | 'lote_fefo' | 'lote_separado' | 'separado_at'
>;
```

> Necessário porque `applyQueuedPickConfirms<T extends MergeableItem>` exige `separado_at: string | null` em `T`. Sem isso o `tsc` quebra no retorno do merge.

- [ ] **Step 2: Reescrever o `ActiveTaskView` pra confirmar itens com optimistic merge**

Substituir a função `ActiveTaskView` inteira (atualmente linhas ~117-199) por:

```tsx
function ActiveTaskView({
  taskId,
  onBack,
  onScan,
}: {
  taskId: string;
  onBack: () => void;
  onScan: (r: ScanResult) => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: items, isLoading } = useQuery({
    queryKey: ['touch-pk-items', taskId],
    queryFn: async (): Promise<PickingTaskItemRow[]> => {
      const { data } = await supabase
        .from('picking_task_items')
        .select('id, product_descricao, quantidade, quantidade_separada, status, lote_fefo, lote_separado, separado_at')
        .eq('picking_task_id', taskId)
        .order('id');
      return (data ?? []) as PickingTaskItemRow[];
    },
  });

  const confirmMutation = useOfflineMutation<{ ok: true }, ConfirmPickItemVars>({
    kind: 'picking.confirm-item',
    mutationFn: confirmPickItem,
  });

  // Re-renderiza quando a fila muda (flush drenando) pra o overlay refletir.
  const [queueVersion, setQueueVersion] = useState(0);
  useEffect(() => subscribeToOfflineQueue(() => setQueueVersion((v) => v + 1)), []);

  // Overlay: mescla confirms enfileirados desta task sobre as linhas do servidor.
  // queueVersion na dep força recomputo quando a fila muda (enqueue/flush).
  const { items: mergedItems, pendingIds } = useMemo(() => {
    const queuedVars = getQueuedByKind<ConfirmPickItemVars>('picking.confirm-item')
      .map((q) => q.variables)
      .filter((v) => v.pickingTaskId === taskId);
    return applyQueuedPickConfirms(items ?? [], queuedVars);
  }, [items, taskId, queueVersion]);

  const total = mergedItems.reduce((s: number, i) => s + (i.quantidade ?? 0), 0);
  const done = mergedItems.reduce((s: number, i) => s + (i.quantidade_separada ?? 0), 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const handleConfirm = async (item: PickingTaskItemRow, payload: ConfirmPayload) => {
    const vars: ConfirmPickItemVars = {
      eventId: crypto.randomUUID(),
      pickingTaskId: taskId,
      pickingTaskItemId: item.id,
      userId: user?.id ?? null,
      quantidade: item.quantidade,
      quantidadeSeparada: payload.quantidadeSeparada,
      loteEsperado: item.lote_fefo,
      loteInformado: payload.loteInformado,
      justificativa: payload.justificativa,
      confirmedAt: new Date().toISOString(),
    };

    // Optimistic instantâneo (feedback <100ms). Reusa o mesmo merge.
    const snapshot = queryClient.getQueryData<PickingTaskItemRow[]>(['touch-pk-items', taskId]);
    queryClient.setQueryData<PickingTaskItemRow[]>(['touch-pk-items', taskId], (old) =>
      old ? applyQueuedPickConfirms(old, [vars]).items : old,
    );

    try {
      const result = await confirmMutation.mutateAsync(vars);
      if (result === null) {
        // Caiu na fila offline — overlay (fila) sustenta o estado.
        toast.info('Salvo offline — sincroniza ao reconectar');
      } else {
        toast.success('Item confirmado');
        queryClient.invalidateQueries({ queryKey: ['touch-pk-items', taskId] });
      }
    } catch {
      // Erro de aplicação (RLS etc.) — rollback do optimistic.
      queryClient.setQueryData(['touch-pk-items', taskId], snapshot);
      toast.error('Falha ao confirmar item');
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-20 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ScanBar onScan={onScan} placeholder="Bipe o endereço ou código do produto" />
      <div className="px-1">
        <Button size="touch" variant="outline" onClick={onBack} className="mb-3">
          ← Voltar
        </Button>
        <div className="space-y-1">
          <div className="flex justify-between text-sm">
            <span className="font-medium">Task {taskId.slice(0, 8)}</span>
            <span className="text-muted-foreground">{done}/{total} ({pct}%)</span>
          </div>
          <Progress value={pct} className="h-3" />
        </div>
      </div>
      <div className="space-y-2 px-1">
        {mergedItems.map((it) => (
          <PickItemConfirmCard
            key={it.id}
            item={it}
            pending={pendingIds.has(it.id)}
            onConfirm={(payload) => handleConfirm(it, payload)}
            disabled={confirmMutation.isPending}
          />
        ))}
      </div>
    </div>
  );
}
```

> A `PickingTaskItemRow` local de `TouchPickingView` (linha ~15) é `Pick<Tables<'picking_task_items'>, 'id'|'product_descricao'|'quantidade'|'quantidade_separada'|'status'|'lote_fefo'|'lote_separado'>` — compatível com a prop `PickItem` do card (mesmos campos). Não precisa mudar o tipo.
> Removeu-se o uso de `Card/CardContent/AlertTriangle/Check/Package` que existiam só no render antigo dos itens — manter os imports que ainda forem usados (ScanBar/Button/Progress/Loader2) e deixar o eslint apontar imports órfãos pra remover.

- [ ] **Step 3: Limpar imports órfãos + lint**

Run: `bunx eslint src/pages/picking/TouchPickingView.tsx`
Remover do topo do arquivo quaisquer imports que o eslint marcar como não usados após a reescrita (provavelmente `Card`, `CardContent`, `Badge`, `Check`, `AlertTriangle` se não usados em outro lugar do arquivo). Manter os usados pela lista de tasks (`Package`, `ChevronRight`) e pelo `ActiveTaskView` (`ScanBar`, `Button`, `Progress`, `Loader2`).
Expected após limpeza: zero erros de lint.

- [ ] **Step 4: Suíte completa + build**

Run:
```bash
bun run vitest run
bun run build
```
Expected: vitest verde; build exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/pages/picking/TouchPickingView.tsx
git commit -m "feat(picking): confirmar item offline-capaz com optimistic merge no TouchPickingView"
```

---

# Phase 5 · Validação final

### Task 8: QA offline real + atualizar CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Suíte + lint + build limpos**

Run:
```bash
bun run vitest run
bun lint
bun run build
```
Expected: vitest = 686 + ~17 novos verdes (5 picking-confirm + 3 getQueuedByKind + 4 merge + 2 handlers + 3 card); lint sem erros novos; build exit 0.

- [ ] **Step 2: QA offline manual (obrigatório — não basta os testes)**

Rodar `/qa` do gstack OU manualmente:
1. `bun dev` → logar como staff → abrir `/admin/estoque/picking/mobile` (TouchPickingView) numa task com itens.
2. DevTools → Network → **Offline**.
3. Confirmar um item (caminho rápido) → esperar: feedback <100ms, card mostra "✓ pendente sync", badge da fila no topbar sobe, toast "Salvo offline".
4. Confirmar outro com **divergência de lote** → exige justificativa → confirma → idem.
5. (Opcional) recarregar a página ainda offline → os itens confirmados continuam "pendente sync" (overlay sobrevive a reload).
6. Network → **Online** → esperar: flush automático, badge da fila zera, cards refletem o servidor (sem "pendente").
7. **Não regredir o recebimento:** repetir 2-6 numa NF em `/recebimento` (confirmar unidade offline → sair da página → reconectar em outra tela → confirmar que a fila drena — valida o fix do bug).

Registrar evidência (antes/depois) no PR.

- [ ] **Step 3: Atualizar CLAUDE.md (§6 item 1 e §9b)**

Em `CLAUDE.md`, §6 item 1 ("Offline-first em picking e recebimento"): trocar o status de 🟡 pra refletir que picking agora tem mutação real offline-capaz (`picking.confirm-item`) + optimistic via fila-como-overlay, e que o registro de handlers foi centralizado. Em §9b (scaffolds pendentes), remover "offline-queue integração real" do que está pendente para picking/recebimento (segue pendente só pra `submitOrder`/UnifiedOrder → PR2). Manter uma linha apontando o spec/plan desta PR.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): reflete picking offline-capaz + registro central de handlers"
```

- [ ] **Step 5: Push + PR (só quando o founder pedir)**

> O founder pediu **não commitar/pushar sem ele pedir** além do que já foi autorizado. Os commits locais acima são esperados; o **push + abertura de PR** só com o ok explícito dele. Quando autorizado:

```bash
git push -u origin claude/offline-picking-optimistic
```
PR title: `feat(offline): picking offline-capaz + optimistic + fix de handler central`
Corpo: resumo dos 3 componentes + checklist de QA offline + nota "sem migration".

---

## Critérios de "feito"

- [ ] `confirmPickItem` idempotente testado (cheio, replay 23505, divergência, parcial, erro RLS).
- [ ] `getQueuedByKind` + `applyQueuedPickConfirms` testados.
- [ ] `registerAllOfflineHandlers` registra os 4 kinds; montado no boot do AppShell.
- [ ] Registros por-página removidos do RecebimentoConferencia (bug do item-preso corrigido).
- [ ] `PickItemConfirmCard` com gating de justificativa em divergência FEFO.
- [ ] `TouchPickingView.ActiveTaskView` confirma item com optimistic merge (offline + online).
- [ ] vitest verde (686 + novos); lint sem erros novos; build exit 0.
- [ ] QA offline manual passou (picking + regressão do recebimento), com evidência.
- [ ] CLAUDE.md atualizado.

## Out-of-scope (PR2)

- `submitOrder` offline (rascunho-local + submit online) — vendedor externo no carro.
- `AdminEstoquePicking` continua read-only (a mutação reaproveitável já existe em `picking-confirm.ts`).
- Background Sync via service worker; retry exponencial por kind; migração pra IndexedDB.
