# Aba "Visitas" no Customer 360 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aba "Visitas" no Customer 360 (`Customer360View`) mostrando o histórico de visitas do cliente (`route_visits`) com resultado/receita/notas + um resumo (total · conversão · receita). Read-only, sem backend.

**Architecture:** Helpers puros `visitResultLabel`/`resumoVisitas` (TDD) → hook `useCustomerVisits` (mirror `useCustomerCalls`) → `CustomerVisitsTab` (mirror `CustomerCallsTab`) → aba no `Customer360View`. Reusa `route_visits` (colunas já existentes, RLS já endurecida no #340).

**Tech Stack:** React, @tanstack/react-query, Supabase JS, shadcn/ui, date-fns, vitest.

**Spec:** `docs/superpowers/specs/2026-06-01-customer360-aba-visitas-design.md`

---

## File Structure
- **Create:** `src/lib/visitas/visit-result.ts` + teste `src/lib/visitas/__tests__/visit-result.test.ts`.
- **Create:** `src/hooks/useCustomerVisits.ts`.
- **Create:** `src/components/customer/CustomerVisitsTab.tsx`.
- **Modify:** `src/components/adminCustomers/Customer360View.tsx` — adicionar a aba.

---

## Task 1: Helpers puros `visitResultLabel` + `resumoVisitas` (TDD)

**Files:**
- Create: `src/lib/visitas/visit-result.ts`
- Test: `src/lib/visitas/__tests__/visit-result.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/visitas/__tests__/visit-result.test.ts
import { describe, it, expect } from 'vitest';
import { visitResultLabel, resumoVisitas } from '../visit-result';

describe('visitResultLabel', () => {
  it('mapeia cada código da taxonomia', () => {
    expect(visitResultLabel('pedido_fechado')).toEqual({ label: 'Pedido fechado', emoji: '✅', tone: 'success' });
    expect(visitResultLabel('interesse').tone).toBe('info');
    expect(visitResultLabel('sem_interesse').tone).toBe('error');
    expect(visitResultLabel('ausente').tone).toBe('warning');
    expect(visitResultLabel('reagendar').emoji).toBe('📅');
  });
  it('null/desconhecido → "Sem resultado"/muted', () => {
    expect(visitResultLabel(null)).toEqual({ label: 'Sem resultado', emoji: '—', tone: 'muted' });
    expect(visitResultLabel('xyz').tone).toBe('muted');
  });
});

describe('resumoVisitas', () => {
  it('total, comResultado, fechados, taxa (fechados/comResultado), receita', () => {
    const r = resumoVisitas([
      { result: 'pedido_fechado', revenue_generated: 1000 },
      { result: 'pedido_fechado', revenue_generated: 500 },
      { result: 'sem_interesse', revenue_generated: null },
      { result: null, revenue_generated: null },
    ]);
    expect(r).toEqual({ total: 4, comResultado: 3, fechados: 2, taxaConversao: 2 / 3, receitaTotal: 1500 });
  });
  it('sem visitas com resultado → taxa null', () => {
    expect(resumoVisitas([{ result: null, revenue_generated: null }]).taxaConversao).toBeNull();
  });
  it('lista vazia → zeros e taxa null', () => {
    expect(resumoVisitas([])).toEqual({ total: 0, comResultado: 0, fechados: 0, taxaConversao: null, receitaTotal: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/customer360-visitas && heavy bun run test -- visit-result`
Expected: FAIL — `Cannot find module '../visit-result'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/visitas/visit-result.ts
export type VisitResultTone = 'success' | 'info' | 'error' | 'warning' | 'muted';
export interface VisitResultLabel {
  label: string;
  emoji: string;
  tone: VisitResultTone;
}

/** Código de `route_visits.result` → rótulo + emoji + tom (tokens text-status-*). */
export function visitResultLabel(result: string | null): VisitResultLabel {
  switch (result) {
    case 'pedido_fechado': return { label: 'Pedido fechado', emoji: '✅', tone: 'success' };
    case 'interesse':      return { label: 'Interesse',      emoji: '🤔', tone: 'info' };
    case 'sem_interesse':  return { label: 'Sem interesse',  emoji: '❌', tone: 'error' };
    case 'ausente':        return { label: 'Ausente',        emoji: '🚫', tone: 'warning' };
    case 'reagendar':      return { label: 'Reagendar',      emoji: '📅', tone: 'warning' };
    default:               return { label: 'Sem resultado',  emoji: '—',  tone: 'muted' };
  }
}

export interface VisitResumoRow {
  result: string | null;
  revenue_generated: number | null;
}
export interface VisitResumo {
  total: number;
  comResultado: number;
  fechados: number;
  taxaConversao: number | null;
  receitaTotal: number;
}

/** Resumo do histórico. taxaConversao = fechados ÷ visitas COM resultado (null se base 0). */
export function resumoVisitas(rows: VisitResumoRow[]): VisitResumo {
  const total = rows.length;
  const comResultado = rows.filter((r) => r.result != null).length;
  const fechados = rows.filter((r) => r.result === 'pedido_fechado').length;
  const taxaConversao = comResultado > 0 ? fechados / comResultado : null;
  const receitaTotal = rows.reduce((s, r) => s + (r.revenue_generated ?? 0), 0);
  return { total, comResultado, fechados, taxaConversao, receitaTotal };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/customer360-visitas && heavy bun run test -- visit-result`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/visitas/visit-result.ts src/lib/visitas/__tests__/visit-result.test.ts
git commit -m "feat(customer360-visitas): helpers visitResultLabel + resumoVisitas (TDD)"
```

---

## Task 2: Hook `useCustomerVisits`

**Files:**
- Create: `src/hooks/useCustomerVisits.ts`

Espelha `src/hooks/useCustomerCalls.ts` (useQuery + colunas específicas + enriquecimento de nomes).

- [ ] **Step 1: Escrever o hook**

```ts
// src/hooks/useCustomerVisits.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface CustomerVisitRow {
  id: string;
  visited_by: string;
  visit_date: string;
  check_in_at: string | null;
  check_out_at: string | null;
  result: string | null;
  notes: string | null;
  revenue_generated: number | null;
  order_created: boolean | null;
  visitedByName: string;
}

/**
 * Histórico de visitas (route_visits) de um cliente, com resultado/receita/notas.
 * RLS de route_visits (endurecida no #340) filtra own/carteira/gestor — degradação honesta.
 * Read-only.
 */
export function useCustomerVisits(customerId: string | null) {
  return useQuery({
    queryKey: ['customer-visits', customerId],
    enabled: !!customerId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<CustomerVisitRow[]> => {
      if (!customerId) return [];
      const { data, error } = await supabase
        .from('route_visits')
        .select('id, visited_by, visit_date, check_in_at, check_out_at, result, notes, revenue_generated, order_created')
        .eq('customer_user_id', customerId)
        .order('check_in_at', { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);

      const rows = data ?? [];
      if (rows.length === 0) return [];

      const ids = [...new Set(rows.map((r) => r.visited_by).filter(Boolean))];
      const { data: profs } = await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', ids);
      const nameMap = new Map((profs ?? []).map((p) => [p.user_id, p.name]));

      return rows.map((r) => ({ ...r, visitedByName: nameMap.get(r.visited_by) || 'Vendedor' }));
    },
  });
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/customer360-visitas && heavy bun run typecheck`
Expected: exit 0. (Confirma o `.select(...)` contra `route_visits` e o shape de `CustomerVisitRow`.)

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useCustomerVisits.ts
git commit -m "feat(customer360-visitas): hook useCustomerVisits (route_visits por cliente + nomes)"
```

---

## Task 3: Componente `CustomerVisitsTab`

**Files:**
- Create: `src/components/customer/CustomerVisitsTab.tsx`

- [ ] **Step 1: Escrever o componente**

```tsx
// src/components/customer/CustomerVisitsTab.tsx
import { Loader2 } from 'lucide-react';
import { useCustomerVisits } from '@/hooks/useCustomerVisits';
import { visitResultLabel, resumoVisitas } from '@/lib/visitas/visit-result';
import { formatBRL, formatPctMaybe } from '@/components/customer360/format';

const toneClass: Record<string, string> = {
  success: 'text-status-success',
  info: 'text-status-info',
  error: 'text-status-error',
  warning: 'text-status-warning',
  muted: 'text-muted-foreground',
};

export function CustomerVisitsTab({ customerId }: { customerId: string }) {
  const { data, isLoading } = useCustomerVisits(customerId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />Carregando…
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="text-center py-8 text-xs text-muted-foreground">
        Nenhuma visita registrada. As visitas com check-out no planejador de rotas aparecem aqui.
      </div>
    );
  }

  const resumo = resumoVisitas(data);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground border-b pb-2">
        <span><strong className="text-foreground">{resumo.total}</strong> visita{resumo.total > 1 ? 's' : ''}</span>
        <span>Conversão: <strong className="text-foreground">{formatPctMaybe(resumo.taxaConversao)}</strong></span>
        <span>Receita: <strong className="text-foreground">{formatBRL(resumo.receitaTotal)}</strong></span>
      </div>

      <div className="space-y-2">
        {data.map((v) => {
          const r = visitResultLabel(v.result);
          const dia = v.check_in_at ? new Date(v.check_in_at).toLocaleDateString('pt-BR') : v.visit_date;
          return (
            <div key={v.id} className="border rounded-md p-2.5 text-sm space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className={`font-medium ${toneClass[r.tone]}`}>{r.emoji} {r.label}</span>
                <span className="text-xs text-muted-foreground font-tabular">{dia}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">por {v.visitedByName}</span>
                {v.result === 'pedido_fechado' && (v.revenue_generated ?? 0) > 0 && (
                  <span className="text-status-success font-medium">{formatBRL(v.revenue_generated)}</span>
                )}
              </div>
              {v.notes && <p className="text-xs text-muted-foreground whitespace-pre-wrap">{v.notes}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verificar typecheck + lint**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/customer360-visitas && heavy bun run typecheck && heavy bun run lint`
Expected: typecheck 0; lint 0 errors. (Confirma imports de `format` + helpers + tokens.)

- [ ] **Step 3: Commit**

```bash
git add src/components/customer/CustomerVisitsTab.tsx
git commit -m "feat(customer360-visitas): CustomerVisitsTab (resumo + histórico com resultado)"
```

---

## Task 4: Adicionar a aba no `Customer360View`

**Files:**
- Modify: `src/components/adminCustomers/Customer360View.tsx`

Referência: o `CustomerCallsTab` é montado em `<TabsContent value="calls">` (~linha 331) e tem `<TabsTrigger value="calls">` na `TabsList`. Adicionar "visits" análogo.

- [ ] **Step 1: Import do componente + ícone**

Junto aos imports de tab (perto do `import { CustomerCallsTab } ...`):
```tsx
import { CustomerVisitsTab } from '@/components/customer/CustomerVisitsTab';
```
Garantir que `MapPin` está importado de `lucide-react` (a linha de imports do lucide já tem vários ícones — adicionar `MapPin` se não estiver).

- [ ] **Step 2: Adicionar o `<TabsTrigger>`**

Na `TabsList`, **após** o trigger de `calls` (Chamadas):
```tsx
          <TabsTrigger value="visits" className="gap-1.5">
            <MapPin className="w-3.5 h-3.5" /> Visitas
          </TabsTrigger>
```

- [ ] **Step 3: Adicionar o `<TabsContent>`**

**Após** o `<TabsContent value="calls" ...>...</TabsContent>` (~linha 333):
```tsx
        <TabsContent value="visits" className="mt-3">
          <CustomerVisitsTab customerId={customer.user_id} />
        </TabsContent>
```

- [ ] **Step 4: Verificar typecheck + lint**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/customer360-visitas && heavy bun run typecheck && heavy bun run lint`
Expected: typecheck 0; lint 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/adminCustomers/Customer360View.tsx
git commit -m "feat(customer360-visitas): aba Visitas no Customer360View"
```

---

## Task 5: Validação final

**Files:** nenhum (só validação)

- [ ] **Step 1: Suíte completa**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/customer360-visitas && heavy bun run typecheck && heavy bun run lint && heavy bun run test && heavy bun run build`
Expected: typecheck 0 · lint 0 errors · test todos passando (incl. os novos de visit-result) · build ✓.

- [ ] **Step 2: Confirmar escopo**

Run: `git diff --stat $(git merge-base HEAD origin/main)`
Expected: só os 4 arquivos de código (2 em `src/lib/visitas/`... na verdade `visit-result.ts` + teste, `useCustomerVisits.ts`, `CustomerVisitsTab.tsx`, `Customer360View.tsx`) + os 2 docs. NÃO toca `route_visits` (schema), `useRoutePlanner`, `CheckoutDialog`, RLS, backend.

---

## Self-Review (autor do plano)

**Spec coverage:**
- §4.1 helpers `visitResultLabel`/`resumoVisitas` → Task 1 ✓
- §4.2 hook `useCustomerVisits` (route_visits por cliente + nomes) → Task 2 ✓
- §4.3 `CustomerVisitsTab` (resumo + lista, badge de resultado, receita, notas) → Task 3 ✓
- §4.4 aba no Customer360View → Task 4 ✓
- §6 fora de escopo (read-only, não toca route_visits/route planner/RLS) → confirmado Task 5 Step 2 ✓

**Placeholder scan:** nenhum TBD; todo passo com código real. `MapPin` confirmado como ícone lucide (verificar se já importado).

**Type consistency:** `visitResultLabel(result: string|null)` e `resumoVisitas(rows)` idênticos em Task 1 (def) e Task 3 (uso). `CustomerVisitRow` (Task 2) consumido na Task 3 (`v.result`, `v.revenue_generated`, `v.visitedByName`, `v.check_in_at`, `v.notes`). `useCustomerVisits` retorna `UseQueryResult<CustomerVisitRow[]>` → `{data, isLoading}` na Task 3. Prop `customerId={customer.user_id}` igual ao `CustomerCallsTab`. `formatBRL`/`formatPctMaybe` de `@/components/customer360/format`.
