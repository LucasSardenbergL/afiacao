# Clientes — escopo por carteira + contagem real — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer `/admin/customers` mostrar só a carteira da vendedora (+ cobertura) com contagem real, lente-aware, sem regredir a visão de gestor/master.

**Architecture:** Dois modos decididos por `useDisplayAccess` (lente-aware): "carteira" (vendedor) busca `carteira_assignments` paginado + `eligible=true` (RLS escopa fora da lente / `.eq(owner)` na lente) e carrega a carteira inteira; "completa" (gestor/master) mantém a paginação de `profiles` + count exato. Scores passam a vir por `customer_user_id` (não `farmer_id`). Toda a lógica não-trivial vai pra helpers puros testáveis em `src/lib/carteira/escopo-clientes.ts`.

**Tech Stack:** React 18, @tanstack/react-query v5, Supabase JS, vitest. Spec: `docs/superpowers/specs/2026-06-11-clientes-escopo-carteira-design.md`.

---

## File Structure

- **Create** `src/lib/carteira/escopo-clientes.ts` — helpers puros (`resolveModoEscopo`, `chunk`, `marcarCobertura`, `ordenarPorNome`), HOFs testáveis (`paginarTudo`, `coletarEmLotes`) e glue Supabase (`fetchCarteiraClientes`, `fetchScoresPorCustomer`).
- **Create** `src/lib/carteira/__tests__/escopo-clientes.test.ts` — vitest dos puros + HOFs.
- **Modify** `src/components/adminCustomers/types.ts` — `coberto_de?` no `Customer`.
- **Modify** `src/components/adminCustomers/useAdminCustomers.ts` — bifurcação de modo, scores por customer, count, reset de lente.
- **Modify** `src/components/adminCustomers/CustomerListView.tsx` — `total`/`isCarteira` props, label dinâmico, badge N/A, badge cobertura, scroll só no modo completa.

---

## Task 1: Helpers puros + HOFs testáveis (TDD)

**Files:**
- Modify: `src/components/adminCustomers/types.ts`
- Create: `src/lib/carteira/escopo-clientes.ts`
- Test: `src/lib/carteira/__tests__/escopo-clientes.test.ts`

- [ ] **Step 1: Adicionar `coberto_de` ao tipo Customer**

Em `src/components/adminCustomers/types.ts`, dentro de `interface Customer`, após `requires_po?: boolean;` adicionar:

```ts
  /** dono original quando o cliente vem de cobertura (owner ≠ baseId); null/ausente se for da própria carteira. */
  coberto_de?: string | null;
```

- [ ] **Step 2: Escrever o teste falhando dos puros + HOFs**

Criar `src/lib/carteira/__tests__/escopo-clientes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  resolveModoEscopo, chunk, marcarCobertura, ordenarPorNome, paginarTudo, coletarEmLotes,
} from '@/lib/carteira/escopo-clientes';

describe('resolveModoEscopo', () => {
  it.each([
    [{ displayIsMaster: true, displayIsGestorComercial: false, displayIsSalesOnly: false }, 'completa'],
    [{ displayIsMaster: false, displayIsGestorComercial: true, displayIsSalesOnly: false }, 'completa'],
    [{ displayIsMaster: false, displayIsGestorComercial: false, displayIsSalesOnly: false }, 'carteira'],
    [{ displayIsMaster: false, displayIsGestorComercial: false, displayIsSalesOnly: true }, 'carteira'],
    // sales-only é a restrição mais forte: ganha mesmo com role gerencial/master
    [{ displayIsMaster: true, displayIsGestorComercial: true, displayIsSalesOnly: true }, 'carteira'],
  ] as const)('flags %o → %s', (flags, esperado) => {
    expect(resolveModoEscopo(flags)).toBe(esperado);
  });
});

describe('chunk', () => {
  it('divide com resto', () => expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]));
  it('lista vazia', () => expect(chunk([], 3)).toEqual([]));
  it('size maior que a lista', () => expect(chunk([1, 2], 5)).toEqual([[1, 2]]));
  it('size inválido lança', () => expect(() => chunk([1], 0)).toThrow());
});

describe('marcarCobertura', () => {
  it('marca coberto_de quando owner ≠ baseId, null quando =', () => {
    const profiles = [{ user_id: 'c1', name: 'A' }, { user_id: 'c2', name: 'B' }];
    const ownerById = new Map([['c1', 'me'], ['c2', 'outro']]);
    const out = marcarCobertura(profiles, ownerById, 'me');
    expect(out[0].coberto_de).toBeNull();
    expect(out[1].coberto_de).toBe('outro');
  });
  it('owner ausente no mapa → coberto_de null', () => {
    const out = marcarCobertura([{ user_id: 'x', name: 'X' }], new Map(), 'me');
    expect(out[0].coberto_de).toBeNull();
  });
});

describe('ordenarPorNome', () => {
  it('ordena respeitando acento e caixa pt-BR', () => {
    const out = ordenarPorNome([{ name: 'Bruno' }, { name: 'Ávila' }, { name: 'ana' }]);
    expect(out.map((x) => x.name)).toEqual(['ana', 'Ávila', 'Bruno']);
  });
});

describe('paginarTudo', () => {
  it('junta páginas até uma incompleta', async () => {
    const pages = [
      Array.from({ length: 1000 }, (_, i) => i),
      Array.from({ length: 1000 }, (_, i) => 1000 + i),
      [2000, 2001],
    ];
    let call = 0;
    const all = await paginarTudo(async () => pages[call++] ?? [], 1000);
    expect(all).toHaveLength(2002);
  });
  it('para na página vazia quando o total é múltiplo do pageSize', async () => {
    const pages = [[1, 2], [3, 4], []];
    let call = 0;
    const all = await paginarTudo(async () => pages[call++] ?? [], 2);
    expect(all).toEqual([1, 2, 3, 4]);
  });
});

describe('coletarEmLotes', () => {
  it('divide em lotes e concatena na ordem', async () => {
    const lotesVistos: number[][] = [];
    const out = await coletarEmLotes([1, 2, 3, 4, 5], 2, async (lote) => {
      lotesVistos.push(lote);
      return lote.map((x) => x * 10);
    });
    expect(lotesVistos).toEqual([[1, 2], [3, 4], [5]]);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });
  it('propaga erro de um lote', async () => {
    await expect(
      coletarEmLotes([1, 2, 3], 2, async (lote) => {
        if (lote.includes(3)) throw new Error('boom');
        return lote;
      }),
    ).rejects.toThrow('boom');
  });
  it('lista vazia → []', async () => {
    expect(await coletarEmLotes([], 2, async () => [99])).toEqual([]);
  });
});
```

- [ ] **Step 3: Rodar o teste e confirmar que falha**

Run: `heavy bun run test src/lib/carteira/__tests__/escopo-clientes.test.ts`
Expected: FAIL — `escopo-clientes` não existe / exports indefinidos.

- [ ] **Step 4: Implementar os puros + HOFs**

Criar `src/lib/carteira/escopo-clientes.ts` (só os puros + HOFs por ora; a glue Supabase vem na Task 2):

```ts
// Escopo de clientes da tela /admin/customers.
// PUROS + HOFs testáveis aqui; a glue Supabase fica na 2ª metade (Task 2).
import { supabase } from '@/integrations/supabase/client';
import type { Customer, ClientScore } from '@/components/adminCustomers/types';

export interface DisplayFlags {
  displayIsMaster: boolean;
  displayIsGestorComercial: boolean;
  displayIsSalesOnly: boolean;
}

/** sales-only é a restrição mais forte (CPF de campo nunca vê a base) → sempre carteira. */
export function resolveModoEscopo(f: DisplayFlags): 'carteira' | 'completa' {
  if (f.displayIsSalesOnly) return 'carteira';
  return f.displayIsMaster || f.displayIsGestorComercial ? 'completa' : 'carteira';
}

export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk: size deve ser > 0');
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function marcarCobertura<T extends { user_id: string }>(
  profiles: T[],
  ownerById: Map<string, string>,
  baseId: string | null,
): (T & { coberto_de: string | null })[] {
  return profiles.map((p) => {
    const owner = ownerById.get(p.user_id) ?? null;
    return { ...p, coberto_de: owner && owner !== baseId ? owner : null };
  });
}

export function ordenarPorNome<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    (a.name ?? '').localeCompare(b.name ?? '', 'pt-BR', { sensitivity: 'base' }),
  );
}

/** Pagina via fetchPage(from,to) até a página vir menor que pageSize. */
export async function paginarTudo<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const page = await fetchPage(from, from + pageSize - 1);
    all.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/** Quebra ids em lotes e concatena os resultados, em ordem. Propaga erro de qualquer lote. */
export async function coletarEmLotes<I, O>(
  ids: I[],
  size: number,
  fetchLote: (lote: I[]) => Promise<O[]>,
): Promise<O[]> {
  const out: O[] = [];
  for (const lote of chunk(ids, size)) {
    out.push(...(await fetchLote(lote)));
  }
  return out;
}
```

- [ ] **Step 5: Rodar o teste e confirmar PASS**

Run: `heavy bun run test src/lib/carteira/__tests__/escopo-clientes.test.ts`
Expected: PASS (todos os describes).

- [ ] **Step 6: Commit**

```bash
git add src/lib/carteira/escopo-clientes.ts src/lib/carteira/__tests__/escopo-clientes.test.ts src/components/adminCustomers/types.ts
git commit -m "feat(clientes): helpers puros de escopo de carteira (modo/chunk/cobertura/paginação)"
```

---

## Task 2: Glue Supabase (fetch da carteira + scores por customer)

**Files:**
- Modify: `src/lib/carteira/escopo-clientes.ts` (append)

- [ ] **Step 1: Adicionar as funções glue ao fim de `escopo-clientes.ts`**

Anexar ao final do arquivo (usam os HOFs acima; importam o `supabase` já importado no topo):

```ts
const LOTE_IN = 150; // 1000 UUIDs estouram o limite de URL do proxy (≠ cap de linhas do PostgREST)

/**
 * Clientes da carteira. Fonte = carteira_assignments (eligible=true), paginado
 * (select puro capa em 1000). Fora da lente a RLS já escopa pra carteira+cobertura;
 * na lente (sessão é o master → RLS vê tudo) filtra pelo owner do alvo.
 */
export async function fetchCarteiraClientes(opts: {
  isImpersonating: boolean;
  effectiveUserId: string | null;
  baseId: string | null;
}): Promise<{ customers: Customer[]; ids: string[] }> {
  const assignments = await paginarTudo<{ customer_user_id: string; owner_user_id: string }>(
    async (from, to) => {
      let q = supabase
        .from('carteira_assignments')
        .select('customer_user_id, owner_user_id')
        .eq('eligible', true);
      if (opts.isImpersonating && opts.effectiveUserId) {
        q = q.eq('owner_user_id', opts.effectiveUserId);
      }
      const { data, error } = await q.order('customer_user_id').range(from, to);
      if (error) throw error;
      return (data ?? []) as { customer_user_id: string; owner_user_id: string }[];
    },
  );

  const ownerById = new Map(assignments.map((a) => [a.customer_user_id, a.owner_user_id]));
  const ids = [...ownerById.keys()];
  if (ids.length === 0) return { customers: [], ids };

  const profiles = await coletarEmLotes(ids, LOTE_IN, async (lote) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('user_id, name, email, phone, document, customer_type, created_at, requires_po')
      .in('user_id', lote)
      .eq('is_employee', false);
    if (error) throw error;
    return (data ?? []) as Customer[];
  });

  const customers = ordenarPorNome(marcarCobertura(profiles, ownerById, opts.baseId));
  return { customers, ids };
}

/**
 * Scores por customer_user_id (não por farmer_id): UNIQUE(customer_user_id) garante
 * 1 linha/cliente, conserta scores stale pós-reatribuição e vazios pro gestor/master.
 * A RLS de farmer_client_scores reforça (pode_ver_carteira_completa OR carteira_visivel_para).
 */
export async function fetchScoresPorCustomer(ids: string[]): Promise<Map<string, ClientScore>> {
  const map = new Map<string, ClientScore>();
  if (ids.length === 0) return map;
  const rows = await coletarEmLotes(ids, LOTE_IN, async (lote) => {
    const { data, error } = await supabase
      .from('farmer_client_scores')
      .select('customer_user_id, health_score, health_class, churn_risk, expansion_score, priority_score, avg_monthly_spend_180d, days_since_last_purchase, category_count, gross_margin_pct, avg_repurchase_interval')
      .in('customer_user_id', lote);
    if (error) throw error;
    return data ?? [];
  });
  for (const s of rows) {
    map.set(s.customer_user_id, {
      customer_user_id: s.customer_user_id,
      health_score: s.health_score ?? 0,
      health_class: s.health_class ?? 'critico',
      churn_risk: s.churn_risk ?? 0,
      expansion_score: s.expansion_score ?? 0,
      priority_score: s.priority_score ?? 0,
      avg_monthly_spend_180d: s.avg_monthly_spend_180d ?? 0,
      days_since_last_purchase: s.days_since_last_purchase ?? 0,
      category_count: s.category_count ?? 0,
      gross_margin_pct: s.gross_margin_pct ?? 0,
    });
  }
  return map;
}
```

- [ ] **Step 2: Typecheck (a glue não tem teste unit; a lógica testável está nos HOFs)**

Run: `heavy bun run typecheck`
Expected: PASS (sem erro novo). Se `farmer_client_scores`/`carteira_assignments` derem erro de tipo gerado, conferir os nomes de coluna contra `src/integrations/supabase/types.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/carteira/escopo-clientes.ts
git commit -m "feat(clientes): fetch da carteira (assignments paginado) + scores por customer_user_id"
```

---

## Task 3: Reescrever `useAdminCustomers` (bifurcação de modo)

**Files:**
- Modify: `src/components/adminCustomers/useAdminCustomers.ts` (substituição integral)

- [ ] **Step 1: Substituir o conteúdo de `useAdminCustomers.ts`**

Conteúdo completo novo do arquivo:

```ts
// Hook de dados/estado do AdminCustomers.
// Dois modos (carteira/completa) decididos por useDisplayAccess (lente-aware).
// Spec: docs/superpowers/specs/2026-06-11-clientes-escopo-carteira-design.md
import { useState, useEffect, useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';
import { toast } from 'sonner';
import {
  resolveModoEscopo, fetchCarteiraClientes, fetchScoresPorCustomer,
} from '@/lib/carteira/escopo-clientes';
import type { Customer, ToolCategory, UserTool, ClientScore, SalesOrder } from './types';

const PAGE_SIZE = 100;

export function useAdminCustomers() {
  const navigate = useNavigate();
  const { customerId } = useParams<{ customerId?: string }>();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { isImpersonating, effectiveUserId } = useImpersonation();
  const { displayIsMaster, displayIsGestorComercial, displayIsSalesOnly, displayLoading } = useDisplayAccess();

  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerTools, setCustomerTools] = useState<UserTool[]>([]);
  const [categories, setCategories] = useState<ToolCategory[]>([]);
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [addToolDialogOpen, setAddToolDialogOpen] = useState(false);

  const modo = resolveModoEscopo({ displayIsMaster, displayIsGestorComercial, displayIsSalesOnly });
  const isCarteira = modo === 'carteira';
  const baseId = isImpersonating ? effectiveUserId : (user?.id ?? null);
  const queriesReady = isStaff && !displayLoading && !!user;

  useEffect(() => {
    if (!authLoading && !isStaff) navigate('/', { replace: true });
  }, [authLoading, isStaff, navigate]);

  // Reset do detalhe ao trocar de lente: A→B não pode deixar o cliente de A na tela.
  useEffect(() => {
    setSelectedCustomer(null);
    setCustomerTools([]);
    setOrders([]);
  }, [effectiveUserId]);

  /* ─── MODO CARTEIRA: carteira inteira de uma vez ─── */
  const carteiraQuery = useQuery({
    queryKey: ['admin-clientes-carteira', baseId, isImpersonating],
    enabled: queriesReady && isCarteira && !!baseId,
    staleTime: 60_000,
    queryFn: () => fetchCarteiraClientes({ isImpersonating, effectiveUserId, baseId }),
  });

  /* ─── MODO COMPLETA: base inteira paginada + count exato ─── */
  const baseQuery = useInfiniteQuery({
    queryKey: ['admin-clientes-base'],
    enabled: queriesReady && !isCarteira,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const start = (pageParam as number) * PAGE_SIZE;
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, name, email, phone, document, customer_type, created_at, requires_po')
        .eq('is_employee', false)
        .order('name')
        .range(start, start + PAGE_SIZE - 1);
      if (error) throw error;
      return (data || []) as Customer[];
    },
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === PAGE_SIZE ? allPages.length : undefined,
  });

  const baseCountQuery = useQuery({
    queryKey: ['admin-clientes-base-count'],
    enabled: queriesReady && !isCarteira,
    staleTime: 60_000,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('profiles')
        .select('user_id', { count: 'exact', head: true })
        .eq('is_employee', false);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const customers = useMemo<Customer[]>(() => {
    if (isCarteira) return carteiraQuery.data?.customers ?? [];
    return baseQuery.data?.pages.flat() ?? [];
  }, [isCarteira, carteiraQuery.data, baseQuery.data]);

  const visibleIds = useMemo(() => customers.map((c) => c.user_id), [customers]);

  /* ─── SCORES por customer_user_id (ambos os modos) ─── */
  const scoresQuery = useQuery({
    queryKey: ['admin-clientes-scores', modo, baseId, visibleIds.length],
    enabled: queriesReady && visibleIds.length > 0,
    staleTime: 60_000,
    queryFn: () => fetchScoresPorCustomer(visibleIds),
  });
  const scores = useMemo(
    () => scoresQuery.data ?? new Map<string, ClientScore>(),
    [scoresQuery.data],
  );

  const total = isCarteira ? customers.length : (baseCountQuery.data ?? customers.length);
  const loading = isCarteira ? carteiraQuery.isLoading : baseQuery.isLoading;

  useEffect(() => {
    if (user && isStaff) loadCategories();
  }, [user, isStaff]);

  useEffect(() => {
    if (customerId && customers.length > 0) {
      const customer = customers.find((c) => c.user_id === customerId);
      if (customer) {
        setSelectedCustomer(customer);
        loadCustomerTools(customerId);
        loadCustomerOrders(customerId);
      }
    }
  }, [customerId, customers]);

  const loadCategories = async () => {
    const { data } = await supabase.from('tool_categories').select('*').order('name');
    if (data) setCategories(data);
  };

  const loadCustomerTools = async (userId: string) => {
    setLoadingTools(true);
    try {
      const { data } = await supabase
        .from('user_tools')
        .select('*, tool_categories (*)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      setCustomerTools((data || []) as unknown as UserTool[]);
    } catch (error) {
      console.error('Error loading customer tools:', error);
    } finally {
      setLoadingTools(false);
    }
  };

  const loadCustomerOrders = async (userId: string) => {
    setLoadingOrders(true);
    try {
      const { data } = await supabase
        .from('sales_orders')
        .select('id, total, status, created_at, items')
        .eq('customer_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);
      setOrders((data || []) as SalesOrder[]);
    } catch (error) {
      console.error('Error loading orders:', error);
    } finally {
      setLoadingOrders(false);
    }
  };

  const handleSelectCustomer = (customer: Customer) => {
    setSelectedCustomer(customer);
    loadCustomerTools(customer.user_id);
    loadCustomerOrders(customer.user_id);
    navigate(`/admin/customers/${customer.user_id}`);
  };

  const handleDeleteTool = async (toolId: string) => {
    try {
      const { error } = await supabase.from('user_tools').delete().eq('id', toolId);
      if (error) throw error;
      toast.success('Ferramenta removida');
      setCustomerTools((prev) => prev.filter((t) => t.id !== toolId));
    } catch (error) {
      toast.error('Erro ao remover');
    }
  };

  const handleBack = () => {
    setSelectedCustomer(null);
    navigate('/admin/customers');
  };

  const reloadSelectedTools = () => {
    if (selectedCustomer) loadCustomerTools(selectedCustomer.user_id);
  };

  return {
    authLoading,
    isStaff,
    loading,
    customers,
    scores,
    categories,
    total,
    isCarteira,
    selectedCustomer,
    customerTools,
    orders,
    loadingTools,
    loadingOrders,
    addToolDialogOpen,
    setAddToolDialogOpen,
    hasNextPage: isCarteira ? false : !!baseQuery.hasNextPage,
    isFetchingNextPage: isCarteira ? false : baseQuery.isFetchingNextPage,
    fetchNextPage: () => { if (!isCarteira) baseQuery.fetchNextPage(); },
    handleSelectCustomer,
    handleDeleteTool,
    handleBack,
    reloadSelectedTools,
  };
}
```

Notas de mudança vs original: removidos o `employeeIdsQuery` + filtro client-side de employees (o `is_employee=false` do DB é a fonte; remover faz o count exato bater com a lista — achado do Codex) e o `loadScores`/estado `scores` (substituído por `scoresQuery` por customer).

- [ ] **Step 2: Typecheck**

Run: `heavy bun run typecheck`
Expected: PASS. (`AdminCustomers.tsx` consome o retorno — ele não passa `total`/`isCarteira` ainda, mas isso é prop nova só no CustomerListView, tratado na Task 4.)

- [ ] **Step 3: Commit**

```bash
git add src/components/adminCustomers/useAdminCustomers.ts
git commit -m "feat(clientes): useAdminCustomers lente-aware (modo carteira/completa, scores por customer, reset de lente)"
```

---

## Task 4: `CustomerListView` — label, contagem, badge N/A, cobertura

**Files:**
- Modify: `src/components/adminCustomers/CustomerListView.tsx`
- Modify: `src/pages/AdminCustomers.tsx` (passar `total`/`isCarteira`)

- [ ] **Step 1: Adicionar `total`/`isCarteira` às props do `CustomerListView`**

Em `CustomerListView.tsx`, na assinatura do componente, adicionar os dois campos. Trocar o bloco de props (linhas ~25-41):

De:
```tsx
export function CustomerListView({
  customers,
  scores,
  loading,
  onSelect,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  customers: Customer[];
  scores: Map<string, ClientScore>;
  loading: boolean;
  onSelect: (c: Customer) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
```

Para:
```tsx
export function CustomerListView({
  customers,
  scores,
  loading,
  total,
  isCarteira,
  onSelect,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  customers: Customer[];
  scores: Map<string, ClientScore>;
  loading: boolean;
  total: number;
  isCarteira: boolean;
  onSelect: (c: Customer) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
```

- [ ] **Step 2: Cabeçalho usa `total` + label honesto por modo**

Trocar (linha ~108):
```tsx
          <p className="text-sm text-muted-foreground">{customers.length} clientes na carteira</p>
```
Por:
```tsx
          <p className="text-sm text-muted-foreground">
            {total} {isCarteira ? 'clientes na carteira' : 'clientes na base'}
          </p>
```

- [ ] **Step 3: Badge de saúde — N/A quando não há score (não fabricar "Crítico")**

Trocar (linhas ~250-251):
```tsx
                const score = scores.get(customer.user_id);
                const healthInfo = HEALTH_CLASSES[score?.health_class || 'critico'];
```
Por:
```tsx
                const score = scores.get(customer.user_id);
                const healthInfo = score ? HEALTH_CLASSES[score.health_class] : undefined;
```

(O JSX `{healthInfo?.label || 'N/A'}` na linha ~279 já cai pra "N/A" quando `healthInfo` é undefined — agora sem score = N/A, não Crítico.)

- [ ] **Step 4: Badge de cobertura ao lado do nome**

No bloco do nome do cliente (logo após o `<p className="font-medium truncate ...">{decodeHtmlEntities(customer.name)}</p>`, linha ~265), adicionar um badge quando `customer.coberto_de`:

De:
```tsx
                        <div className="min-w-0">
                          <p className="font-medium truncate text-foreground">{decodeHtmlEntities(customer.name)}</p>
                          {customer.phone && (
                            <p className="text-xs text-muted-foreground">{customer.phone}</p>
                          )}
                        </div>
```
Para:
```tsx
                        <div className="min-w-0">
                          <p className="font-medium truncate text-foreground flex items-center gap-1.5">
                            <span className="truncate">{decodeHtmlEntities(customer.name)}</span>
                            {customer.coberto_de && (
                              <Badge variant="outline" className="text-[10px] shrink-0 text-status-info border-status-info/40">
                                cobertura
                              </Badge>
                            )}
                          </p>
                          {customer.phone && (
                            <p className="text-xs text-muted-foreground">{customer.phone}</p>
                          )}
                        </div>
```

- [ ] **Step 5: Rodapé "todos carregados" usa `total` e some no modo carteira sem ruído**

Trocar (linhas ~340-344):
```tsx
        {!hasNextPage && customers.length > 0 && (
          <p className="text-center text-xs text-muted-foreground py-4 border-t">
            Todos os clientes carregados ({customers.length})
          </p>
        )}
```
Por:
```tsx
        {!hasNextPage && customers.length > 0 && !isCarteira && (
          <p className="text-center text-xs text-muted-foreground py-4 border-t">
            Todos os clientes carregados ({total})
          </p>
        )}
```

(No modo carteira a lista já é o total; o rodapé "carregados" não agrega — só no modo completa, onde scroll infinito chegou ao fim.)

- [ ] **Step 6: Passar `total`/`isCarteira` em `AdminCustomers.tsx`**

Em `src/pages/AdminCustomers.tsx`, desestruturar `total` e `isCarteira` do hook (no bloco `const { ... } = useAdminCustomers();`) e passá-los ao `<CustomerListView>`:

Adicionar `total,` e `isCarteira,` à desestruturação, e no JSX do `<CustomerListView ...>` adicionar:
```tsx
          total={total}
          isCarteira={isCarteira}
```

- [ ] **Step 7: Typecheck + lint**

Run: `heavy bun run typecheck && bun lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/adminCustomers/CustomerListView.tsx src/pages/AdminCustomers.tsx
git commit -m "feat(clientes): label/contagem por modo, badge N/A sem score, badge de cobertura"
```

---

## Task 5: Verificação final

- [ ] **Step 1: Suite completa**

Run: `heavy bun run typecheck && heavy bun run test && bun lint`
Expected: tudo verde (241+ testes, incluindo os novos de escopo-clientes).

- [ ] **Step 2: Build**

Run: `heavy bun build`
Expected: build sem erro.

- [ ] **Step 3: Revisão de critério de pronto (do spec)**

Conferir mentalmente contra o spec:
- Vendedora real: carteira + cobertos marcados, contagem real, busca varre tudo.
- Lente de vendedora: idem, escopado ao alvo (sessão master → `.eq(owner, alvo)`).
- Gestor/master: base inteira, count exato, label "na base".
- Sem score → "N/A", não "Crítico".

- [ ] **Step 4: Commit final (se algo sobrou) + resumo**

Nada a commitar se as tasks anteriores fecharam. Resumir o que mudou e as pendências (Publish do front no Lovable pra ir ao ar — é frontend-only, sem migration/edge).

---

## Notas de execução

- `heavy` prefixo nos comandos pesados (M2 8GB, worktrees paralelas) — §2 do CLAUDE.md.
- **Frontend-only**: sem migration, sem edge, sem deploy de backend. Pra ir ao ar precisa só do **Publish do front no Lovable** (§"Deploy do FRONTEND" do CLAUDE.md).
- A glue Supabase (`fetchCarteiraClientes`/`fetchScoresPorCustomer`) não tem teste unit (mock do builder é frágil); a lógica testável está nos HOFs `paginarTudo`/`coletarEmLotes` + puros. Verificação real da glue = device/preview do founder.
- Limitações v1 no spec (cobertura do alvo na lente; `valid_from`; count base aproximado; assignment sem profile).
