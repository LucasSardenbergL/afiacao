# Offline-First Recebimento Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrar o scaffold de `offline-queue` em mutations reais. Esta PR cobre infra (`useOfflineMutation` + auto-flush + telemetria) + integração na `RecebimentoConferencia.handleConfirmUnit` (4 mutations sequenciais). UnifiedOrder fica pra PR separada.

**Architecture:** Hook `useOfflineMutation` wrap `useMutation` da react-query: tenta online; se `!navigator.onLine` ou erro de rede, `enqueue(kind, variables)` + toast "salvo offline"; quando `online` event dispara, `flushAll()` chama handler registrado por kind. Telemetria PostHog mede tamanho da fila + sucesso/falha do flush.

**Tech Stack:** React + react-query + offline-queue.ts (já scaffold) + posthog-js

**Spec base**: deriva da auditoria UX Fase 4 (#16-19 do roadmap) — não tem spec própria, comportamento documentado neste plan.

---

## File Structure

**Novos arquivos:**
```
src/hooks/
  useOfflineMutation.ts                          # wrapper sobre useMutation com enqueue fallback
  useOfflineFlush.ts                             # listener 'online' event + dispatch por kind

src/hooks/__tests__/
  useOfflineMutation.test.tsx
  useOfflineFlush.test.tsx

src/lib/dashboard/__tests__/
  (nenhum)
```

**Arquivos editados:**
```
src/pages/RecebimentoConferencia.tsx              # handleConfirmUnit usa useOfflineMutation
src/components/AppShell.tsx                       # monta useOfflineFlush()
src/components/shell/NetworkStatusIndicator.tsx   # badge "X aguardando" quando depth>0
src/lib/offline-queue.ts                          # adiciona track() events
```

---

# Phase 1 · Infra

### Task 1: Estender `offline-queue.ts` com telemetria

**Files:**
- Modify: `src/lib/offline-queue.ts`

- [ ] **Step 1: Adicionar telemetria em enqueue/flush/clear**

Editar `src/lib/offline-queue.ts`. Adicionar import no topo:

```ts
import { track } from '@/lib/analytics';
```

Em `enqueue()`, antes do `return id;`:

```ts
  track('offline.queued', { kind, queue_depth: items.length });
```

Em `flush()`, antes do `return`:

```ts
  track('offline.flushed', { success, failed, remaining: remaining.length });
```

Em `clearOfflineQueue()`, antes do `writeQueue([])`:

```ts
  const beforeDepth = readQueue().length;
  if (beforeDepth > 0) track('offline.cleared', { depth: beforeDepth });
```

- [ ] **Step 2: Validar lint**

```bash
bunx eslint src/lib/offline-queue.ts
```

Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/lib/offline-queue.ts
git commit -m "feat(offline): telemetria PostHog (offline.queued/flushed/cleared)"
```

---

### Task 2: Hook `useOfflineMutation` (TDD)

**Files:**
- Create: `src/hooks/useOfflineMutation.ts`
- Create: `src/hooks/__tests__/useOfflineMutation.test.tsx`

- [ ] **Step 1: Escrever teste primeiro**

Create `src/hooks/__tests__/useOfflineMutation.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/offline-queue', () => ({
  enqueue: vi.fn().mockResolvedValue('mock-id'),
}));

import { enqueue } from '@/lib/offline-queue';
import { useOfflineMutation } from '../useOfflineMutation';

const mockedEnqueue = vi.mocked(enqueue);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  mockedEnqueue.mockClear();
  // Default online
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('useOfflineMutation', () => {
  it('runs mutationFn directly when online + success', async () => {
    const mutationFn = vi.fn().mockResolvedValue({ ok: true });
    const { result } = renderHook(
      () =>
        useOfflineMutation({
          kind: 'test.action',
          mutationFn,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({ foo: 'bar' });
    });

    expect(mutationFn).toHaveBeenCalledWith({ foo: 'bar' });
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(result.current.queued).toBe(false);
  });

  it('enqueues when offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const mutationFn = vi.fn();
    const { result } = renderHook(
      () =>
        useOfflineMutation({
          kind: 'test.action',
          mutationFn,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({ foo: 'bar' });
    });

    expect(mockedEnqueue).toHaveBeenCalledWith('test.action', { foo: 'bar' });
    expect(mutationFn).not.toHaveBeenCalled();
    expect(result.current.queued).toBe(true);
  });

  it('enqueues when online but network error thrown', async () => {
    const mutationFn = vi.fn().mockRejectedValue(new TypeError('NetworkError when attempting to fetch'));
    const { result } = renderHook(
      () =>
        useOfflineMutation({
          kind: 'test.action',
          mutationFn,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({ foo: 'bar' });
    });

    expect(mutationFn).toHaveBeenCalled();
    expect(mockedEnqueue).toHaveBeenCalledWith('test.action', { foo: 'bar' });
    expect(result.current.queued).toBe(true);
  });

  it('does NOT enqueue when online + non-network error (lets it throw)', async () => {
    const err = new Error('Validation failed');
    const mutationFn = vi.fn().mockRejectedValue(err);
    const { result } = renderHook(
      () =>
        useOfflineMutation({
          kind: 'test.action',
          mutationFn,
        }),
      { wrapper },
    );

    await act(async () => {
      try {
        await result.current.mutateAsync({ foo: 'bar' });
      } catch {
        /* expected */
      }
    });

    expect(mutationFn).toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar test → FAIL (hook não existe)**

```bash
bun run vitest run src/hooks/__tests__/useOfflineMutation.test.tsx
```

- [ ] **Step 3: Implementar hook**

Create `src/hooks/useOfflineMutation.ts`:

```ts
import { useState } from 'react';
import { useMutation, type UseMutationOptions } from '@tanstack/react-query';
import { enqueue } from '@/lib/offline-queue';

/**
 * Detecta erro de rede vs erro de aplicação. Erros de rede vão pra fila;
 * erros de validação (400/422 etc) propagam normalmente.
 */
function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  if (err instanceof TypeError && /network|fetch|failed/i.test(err.message)) return true;
  // PostgREST sem rede pode estourar genérico — checkar mensagem
  if (err instanceof Error && /networkerror|failed to fetch|load failed/i.test(err.message)) return true;
  return false;
}

export interface UseOfflineMutationOptions<TData, TVars> {
  /** Identificador estável da mutação (ex: 'recebimento.confirm-unit'). */
  kind: string;
  /** Função executada online. */
  mutationFn: (vars: TVars) => Promise<TData>;
  /** Callbacks opcionais (passa direto pro useMutation). */
  onSuccess?: UseMutationOptions<TData, Error, TVars>['onSuccess'];
  onError?: UseMutationOptions<TData, Error, TVars>['onError'];
}

export interface UseOfflineMutationReturn<TData, TVars> {
  mutateAsync: (vars: TVars) => Promise<TData | null>;
  isPending: boolean;
  /** True quando última chamada caiu na fila offline. */
  queued: boolean;
  /** Limpa flag queued (UI reset). */
  resetQueued: () => void;
}

/**
 * Envolve useMutation com fallback offline: se navigator.onLine === false
 * OU mutationFn falha com erro de rede, chama `enqueue(kind, variables)`.
 * Retorna `null` quando enfileira (caller decide UX).
 *
 * Padrão de uso:
 *   const m = useOfflineMutation({
 *     kind: 'recebimento.confirm-unit',
 *     mutationFn: async (vars) => supabase.from('nfe_recebimentos').update(...).eq('id', vars.id),
 *   });
 *   const r = await m.mutateAsync({ id, status });
 *   if (m.queued) toast.info('Salvo offline — vai sincronizar quando conectar');
 */
export function useOfflineMutation<TData, TVars>({
  kind,
  mutationFn,
  onSuccess,
  onError,
}: UseOfflineMutationOptions<TData, TVars>): UseOfflineMutationReturn<TData, TVars> {
  const [queued, setQueued] = useState(false);

  const mutation = useMutation<TData, Error, TVars>({
    mutationFn,
    onSuccess,
    onError,
  });

  const mutateAsync = async (vars: TVars): Promise<TData | null> => {
    // 1. Offline imediato → enfileira sem nem tentar
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await enqueue(kind, vars);
      setQueued(true);
      return null;
    }

    // 2. Online → tenta. Cai pra fila se erro de rede.
    try {
      setQueued(false);
      return await mutation.mutateAsync(vars);
    } catch (err) {
      if (isNetworkError(err)) {
        await enqueue(kind, vars);
        setQueued(true);
        return null;
      }
      throw err;
    }
  };

  return {
    mutateAsync,
    isPending: mutation.isPending,
    queued,
    resetQueued: () => setQueued(false),
  };
}
```

- [ ] **Step 4: Rodar test → PASS**

```bash
bun run vitest run src/hooks/__tests__/useOfflineMutation.test.tsx
```

Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useOfflineMutation.ts src/hooks/__tests__/useOfflineMutation.test.tsx
git commit -m "feat(offline): useOfflineMutation (online try + offline enqueue fallback, 4 tests)"
```

---

### Task 3: Hook `useOfflineFlush` + auto-flush

**Files:**
- Create: `src/hooks/useOfflineFlush.ts`
- Create: `src/hooks/__tests__/useOfflineFlush.test.tsx`

- [ ] **Step 1: Test first**

Create `src/hooks/__tests__/useOfflineFlush.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const mockFlushImpl = vi.fn();
const mockSubscribe = vi.fn();

vi.mock('@/lib/offline-queue', () => ({
  flush: (...args: unknown[]) => mockFlushImpl(...args),
  subscribeToOfflineQueue: (...args: unknown[]) => mockSubscribe(...args),
}));

import { useOfflineFlush, registerOfflineHandler, __clearHandlersForTest } from '../useOfflineFlush';

beforeEach(() => {
  mockFlushImpl.mockReset();
  mockSubscribe.mockReset();
  mockSubscribe.mockReturnValue(() => undefined);
  __clearHandlersForTest();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('useOfflineFlush', () => {
  it('registers online event listener on mount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    renderHook(() => useOfflineFlush());
    expect(addSpy).toHaveBeenCalledWith('online', expect.any(Function));
    addSpy.mockRestore();
  });

  it('calls flush when online event fires', async () => {
    mockFlushImpl.mockResolvedValue({ success: 2, failed: 0 });
    renderHook(() => useOfflineFlush());

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(mockFlushImpl).toHaveBeenCalled());
  });

  it('routes mutations to registered handler by kind', async () => {
    const handler = vi.fn().mockResolvedValue(true);
    registerOfflineHandler('test.kind', handler);

    // O hook passa um wrapper que despacha por kind. Vamos chamar o wrapper diretamente.
    mockFlushImpl.mockImplementation(async (wrapper: (m: { kind: string; variables: unknown }) => Promise<boolean>) => {
      const ok = await wrapper({ kind: 'test.kind', variables: { x: 1 } });
      return { success: ok ? 1 : 0, failed: ok ? 0 : 1 };
    });

    renderHook(() => useOfflineFlush());

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(handler).toHaveBeenCalledWith({ x: 1 }));
  });

  it('returns false for unknown kind (item stays in queue)', async () => {
    mockFlushImpl.mockImplementation(async (wrapper: (m: { kind: string; variables: unknown }) => Promise<boolean>) => {
      const ok = await wrapper({ kind: 'no.handler', variables: {} });
      return { success: ok ? 1 : 0, failed: ok ? 0 : 1 };
    });

    renderHook(() => useOfflineFlush());

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(mockFlushImpl).toHaveBeenCalled());
    // (não dá pra checar o retorno diretamente, mas garantimos que não crashou)
  });
});
```

- [ ] **Step 2: Rodar → FAIL**

```bash
bun run vitest run src/hooks/__tests__/useOfflineFlush.test.tsx
```

- [ ] **Step 3: Implementar**

Create `src/hooks/useOfflineFlush.ts`:

```ts
import { useEffect } from 'react';
import { flush, subscribeToOfflineQueue, type QueuedMutation } from '@/lib/offline-queue';
import { logger } from '@/lib/logger';

type Handler = (variables: unknown) => Promise<boolean>;

/** Registry global de handlers por kind. */
const handlers = new Map<string, Handler>();

/**
 * Registra um handler que processará mutations enfileiradas de um determinado kind.
 * Chamar uma única vez (e.g. no mount da página que faz a mutação).
 *
 * Handler retorna:
 *  - true: mutação aplicou; item é removido da fila
 *  - false: mutação ainda falha; item fica na fila com attempts++
 *  - throw: idem
 */
export function registerOfflineHandler<TVars>(
  kind: string,
  handler: (variables: TVars) => Promise<boolean>,
): () => void {
  handlers.set(kind, handler as Handler);
  return () => handlers.delete(kind);
}

/**
 * Hook montado uma vez (no AppShell). Escuta 'online' event e dispara flush
 * que despacha cada item da fila pro handler registrado pra aquele kind.
 * Kinds sem handler registrado ficam na fila (não-destrutivo).
 */
export function useOfflineFlush(): void {
  useEffect(() => {
    const dispatcher = async (m: QueuedMutation): Promise<boolean> => {
      const h = handlers.get(m.kind);
      if (!h) {
        logger.warn('Offline flush: nenhum handler para kind', { kind: m.kind });
        return false;
      }
      try {
        return await h(m.variables);
      } catch (e) {
        logger.warn('Offline flush: handler throw', {
          kind: m.kind,
          error: e instanceof Error ? e.message : String(e),
        });
        return false;
      }
    };

    const onOnline = () => {
      void flush(dispatcher);
    };

    window.addEventListener('online', onOnline);

    // Ao montar, se já tem itens E está online, tenta flush imediatamente.
    const unsub = subscribeToOfflineQueue((depth) => {
      if (depth > 0 && typeof navigator !== 'undefined' && navigator.onLine) {
        void flush(dispatcher);
      }
    });

    return () => {
      window.removeEventListener('online', onOnline);
      unsub();
    };
  }, []);
}

/** Helper de teste — não exportar via barrel. */
export function __clearHandlersForTest(): void {
  handlers.clear();
}
```

- [ ] **Step 4: Test → PASS**

```bash
bun run vitest run src/hooks/__tests__/useOfflineFlush.test.tsx
```

Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useOfflineFlush.ts src/hooks/__tests__/useOfflineFlush.test.tsx
git commit -m "feat(offline): useOfflineFlush + registerOfflineHandler (auto-flush on 'online' event)"
```

---

### Task 4: Montar `useOfflineFlush()` no AppShell

**Files:**
- Modify: `src/components/AppShell.tsx`

- [ ] **Step 1: Adicionar import + chamada no exported AppShell component**

No topo do arquivo (próximo aos outros imports de hooks):

```ts
import { useOfflineFlush } from '@/hooks/useOfflineFlush';
```

Dentro de `export function AppShell({ children })`, logo após o `useRouteTracker()`:

```ts
  useOfflineFlush();
```

- [ ] **Step 2: Validar lint + tests**

```bash
bunx eslint src/components/AppShell.tsx
bun run vitest run
```

Expected: zero erros novos.

- [ ] **Step 3: Commit**

```bash
git add src/components/AppShell.tsx
git commit -m "feat(appshell): monta useOfflineFlush() pra processar fila offline ao reconectar"
```

---

# Phase 2 · Integração na RecebimentoConferencia

### Task 5: `handleConfirmUnit` usa `useOfflineMutation`

**Files:**
- Modify: `src/pages/RecebimentoConferencia.tsx`

- [ ] **Step 1: Ler estrutura atual do handleConfirmUnit**

Identificar as 4 mutations no método `handleConfirmUnit` (linhas ~178-310). Elas são uma sequência de:
1. `update nfe_recebimentos status='em_conferencia'`
2. `update nfe_recebimentos status='divergencia'` (caso B)
3. `insert cte_associados`
4. `update nfe_recebimentos` (final)

> **Decisão**: encapsular toda a sequência num único `kind: 'recebimento.confirm-unit'` com variables = todo o snapshot necessário pra refazer offline. Variables incluem: `nfeId`, `cteData?`, `status` final, payloads dos updates intermediários.

- [ ] **Step 2: Extrair lógica das 4 mutations num service**

Create `src/services/recebimento-confirm.ts`:

```ts
import { supabase } from '@/integrations/supabase/client';

export interface ConfirmUnitVars {
  nfeId: string;
  status: 'em_conferencia' | 'divergencia' | 'conferido';
  cteAssociado?: {
    nfe_id: string;
    cte_numero: string;
    observacoes?: string;
  } | null;
  finalUpdate?: {
    transportadora?: string;
    observacoes?: string;
    [k: string]: unknown;
  };
}

export async function confirmUnit(vars: ConfirmUnitVars): Promise<{ ok: true }> {
  // 1. Update inicial pra status='em_conferencia' (apenas se status final ≠ esse)
  if (vars.status === 'divergencia') {
    const { error } = await supabase
      .from('nfe_recebimentos')
      .update({ status: 'divergencia' })
      .eq('id', vars.nfeId);
    if (error) throw error;
    return { ok: true };
  }

  // status 'conferido' ou 'em_conferencia' segue fluxo normal
  const { error: e1 } = await supabase
    .from('nfe_recebimentos')
    .update({ status: 'em_conferencia' })
    .eq('id', vars.nfeId);
  if (e1) throw e1;

  // 2. Insert CTE se houver
  if (vars.cteAssociado) {
    const { error: e2 } = await supabase
      .from('cte_associados')
      .insert(vars.cteAssociado);
    if (e2) throw e2;
  }

  // 3. Update final
  if (vars.finalUpdate) {
    const { error: e3 } = await supabase
      .from('nfe_recebimentos')
      .update({ ...vars.finalUpdate, status: vars.status })
      .eq('id', vars.nfeId);
    if (e3) throw e3;
  }

  return { ok: true };
}
```

- [ ] **Step 3: Substituir mutations inline em RecebimentoConferencia.tsx por hook**

No componente `RecebimentoConferencia` (próximo ao topo), adicionar:

```tsx
import { useOfflineMutation } from '@/hooks/useOfflineMutation';
import { registerOfflineHandler } from '@/hooks/useOfflineFlush';
import { confirmUnit, type ConfirmUnitVars } from '@/services/recebimento-confirm';
import { useEffect } from 'react';
```

Logo após declarações de hooks no componente:

```tsx
  const confirmMutation = useOfflineMutation<{ ok: true }, ConfirmUnitVars>({
    kind: 'recebimento.confirm-unit',
    mutationFn: confirmUnit,
  });

  // Registra handler global pra flush automático (1x na app)
  useEffect(() => {
    return registerOfflineHandler<ConfirmUnitVars>('recebimento.confirm-unit', async (vars) => {
      await confirmUnit(vars);
      return true;
    });
  }, []);
```

Substituir as 4 chamadas `await supabase.from('nfe_recebimentos').update(...)` etc dentro de `handleConfirmUnit` por:

```tsx
  const handleConfirmUnit = async () => {
    // ... lógica de validação anterior, montagem de vars ...
    const vars: ConfirmUnitVars = {
      nfeId: id!,
      status: /* deriva do contexto */ 'conferido',
      cteAssociado: /* se houver, monta */ null,
      finalUpdate: /* monta o payload final, se houver */ undefined,
    };

    await confirmMutation.mutateAsync(vars);

    if (confirmMutation.queued) {
      toast.info('Salvo offline — vai sincronizar quando reconectar');
    } else {
      toast.success('Confirmado');
      // navigate ou reload conforme já existia
    }
  };
```

> **Atenção**: a estrutura exata depende do código existente. Manter toda a lógica de validação e UX pre-existentes; substituir SOMENTE as chamadas Supabase pelo `confirmMutation.mutateAsync(vars)`. Se o fluxo original tinha múltiplos paths (divergência vs conferido), o `ConfirmUnitVars.status` discrimina e o service decide as queries certas.

- [ ] **Step 4: Validar lint + tests + manual smoke**

```bash
bunx eslint src/services/recebimento-confirm.ts src/pages/RecebimentoConferencia.tsx
bun run vitest run
```

Expected: zero erros novos; tests passam.

Manual: `bun dev` → abrir uma NF em recebimento → DevTools Network → "Offline" → clicar Confirmar → ver toast "Salvo offline" + badge na NetworkStatusIndicator subir. Voltar online → ver flush automático no console + queue zerar.

- [ ] **Step 5: Commit**

```bash
git add src/services/recebimento-confirm.ts src/pages/RecebimentoConferencia.tsx
git commit -m "feat(recebimento): handleConfirmUnit usa useOfflineMutation (4 mutations encapsuladas em service)"
```

---

# Phase 3 · UI feedback

### Task 6: Badge "X aguardando sync" no NetworkStatusIndicator

**Files:**
- Modify: `src/components/shell/NetworkStatusIndicator.tsx`

- [ ] **Step 1: Ler estado atual**

```bash
cat src/components/shell/NetworkStatusIndicator.tsx | head -50
```

Identificar onde o componente lê `depth`. Provavelmente já mostra count, mas vale conferir se é proeminente.

- [ ] **Step 2: Ajustar visual se necessário**

Se já mostra badge proeminente, **não fazer nada**. Se não mostra, adicionar:

```tsx
{depth > 0 && (
  <Badge variant="outline" className="bg-status-warning-bg text-status-warning-bold border-status-warning-bold/30 text-[10px] px-1.5">
    {depth} aguardando
  </Badge>
)}
```

> **Nota**: este step pode virar no-op se NetworkStatusIndicator já mostrava count. Em caso de no-op, pular Task 6 e ir pra Task 7.

- [ ] **Step 3: Commit (se houve mudança)**

```bash
git add src/components/shell/NetworkStatusIndicator.tsx
git commit -m "chore(network-indicator): badge proeminente quando fila offline > 0"
```

---

# Phase 4 · Final

### Task 7: Validação + PR

- [ ] **Step 1: Full suite**

```bash
bun run vitest run
bun run build
```

Expected:
- Tests: 180+ (172 base + 8 novos: 4 useOfflineMutation + 4 useOfflineFlush)
- Build: exit 0

- [ ] **Step 2: Push**

```bash
git push -u origin claude/offline-first-picking-recebimento
```

- [ ] **Step 3: PR via controller**

PR title: `offline-first(recebimento): useOfflineMutation + auto-flush + integração RecebimentoConferencia`

---

## Critérios de "feito"

- [ ] useOfflineMutation testado (4 cenários: online OK, offline imediato, network error, validation error)
- [ ] useOfflineFlush testado (4 cenários: listener, online event, registered handler, unknown kind)
- [ ] Telemetria PostHog: `offline.queued`, `offline.flushed`, `offline.cleared`
- [ ] RecebimentoConferencia.handleConfirmUnit usa hook + registra handler
- [ ] Smoke manual: offline → toast salvo → online → flush automático → queue zerada
- [ ] Build exit 0

## Out-of-scope desta PR (próximas)

- **UnifiedOrder offline** — vendedor externo no carro. PR2 dedicada, ~1 dia.
- **Picking offline** — quando TouchPickingView sair de scaffold e tiver mutations reais.
- **Conflict resolution** — hoje sem detecção; ON CONFLICT do PG resolve básico.
- **Background sync via service worker** — Workbox Background Sync API exige config própria, fica pra v2.
- **Retry exponencial por kind** — hoje todos os attempts++ uniforme.
- **IndexedDB migration** — localStorage cobre até ~5MB.

## Pós-deploy

1. Conferente conferindo NF perde sinal → Confirmar → toast "salvo offline" → ele continua → sinal volta → flush automático.
2. PostHog dashboard "Offline" mostra adoção (chart `offline.queued` por dia + funnel `queued → flushed` taxa de sucesso).
