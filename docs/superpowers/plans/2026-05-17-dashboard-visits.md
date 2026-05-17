# dashboard_visits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistir timestamps de visita do dashboard server-side em tabela `dashboard_visits`, complementando (não substituindo) `localStorage.dashboardLastVisit`. Habilita análise cross-device + histórico server-side de "quem visitou quando".

**Architecture:** Tabela `dashboard_visits` (RLS scoped: user lê/insere o próprio, master lê todos) + refactor de `useLastVisit` pra hybrid (server-first via react-query, localStorage como fallback offline). Sem Edge Function — client faz INSERT direto + query da visita anterior numa única roundtrip via `range(1, 1)`.

**Tech Stack:** Postgres + Supabase RLS + react-query + vitest

**Spec base:** [docs/superpowers/specs/2026-05-17-dashboard-visits-design.md](../specs/2026-05-17-dashboard-visits-design.md)

---

## File Structure

**Novos arquivos:**
```
supabase/migrations/
  20260517140000_dashboard_visits.sql            # tabela + RLS + index

src/integrations/supabase/
  types-dashboard-visits.ts                       # extensão Database type

src/hooks/__tests__/
  useLastVisit.test.ts                            # tests novos pro refactor
```

**Arquivos editados:**
```
src/hooks/useLastVisit.ts                         # hybrid server+local
```

---

# Phase 1 · Schema

### Task 1: Migration `dashboard_visits`

**Files:**
- Create: `supabase/migrations/20260517140000_dashboard_visits.sql`

- [ ] **Step 1: Criar migration**

```sql
-- ============================================================
-- dashboard_visits — persiste visits ao /  pra análise histórica
-- + suporte cross-device de lastVisit.
-- Spec: docs/superpowers/specs/2026-05-17-dashboard-visits-design.md
-- ============================================================

CREATE TABLE IF NOT EXISTS public.dashboard_visits (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  visited_at timestamptz NOT NULL DEFAULT now(),
  persona text,
  company_selection text,
  session_minutes integer,
  CONSTRAINT dashboard_visits_unique_visit UNIQUE (user_id, visited_at)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_visits_user_recent
  ON public.dashboard_visits (user_id, visited_at DESC);

ALTER TABLE public.dashboard_visits ENABLE ROW LEVEL SECURITY;

-- User insere o próprio
DROP POLICY IF EXISTS "dashboard_visits_user_insert" ON public.dashboard_visits;
CREATE POLICY "dashboard_visits_user_insert"
  ON public.dashboard_visits
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- User lê o próprio
DROP POLICY IF EXISTS "dashboard_visits_user_read" ON public.dashboard_visits;
CREATE POLICY "dashboard_visits_user_read"
  ON public.dashboard_visits
  FOR SELECT
  USING (auth.uid() = user_id);

-- Master lê todos
DROP POLICY IF EXISTS "dashboard_visits_master_read" ON public.dashboard_visits;
CREATE POLICY "dashboard_visits_master_read"
  ON public.dashboard_visits
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'master'::public.app_role
    )
  );

-- Service role bypass
DROP POLICY IF EXISTS "dashboard_visits_service_all" ON public.dashboard_visits;
CREATE POLICY "dashboard_visits_service_all"
  ON public.dashboard_visits
  FOR ALL
  USING (auth.role() = 'service_role');
```

- [ ] **Step 2:** Verify file size

```bash
wc -l supabase/migrations/20260517140000_dashboard_visits.sql
```

Expected: ~50 linhas.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260517140000_dashboard_visits.sql
git commit -m "feat(db): dashboard_visits table + RLS (user inserts/reads own, master reads all)"
```

---

# Phase 2 · Types

### Task 2: Extension types

**Files:**
- Create: `src/integrations/supabase/types-dashboard-visits.ts`

- [ ] **Step 1: Criar arquivo**

```ts
/**
 * Extensão manual do Database type para tabela dashboard_visits
 * adicionada na migration 20260517140000.
 */

export interface DashboardVisitRow {
  id: number;
  user_id: string;
  visited_at: string;
  persona: string | null;
  company_selection: string | null;
  session_minutes: number | null;
}

export interface DashboardVisitInsert {
  user_id: string;
  visited_at?: string;
  persona?: string | null;
  company_selection?: string | null;
  session_minutes?: number | null;
}
```

- [ ] **Step 2: Lint + commit**

```bash
bunx eslint src/integrations/supabase/types-dashboard-visits.ts
git add src/integrations/supabase/types-dashboard-visits.ts
git commit -m "types(supabase): adiciona DashboardVisit row/insert types"
```

---

# Phase 3 · Refactor `useLastVisit`

### Task 3: Híbrido server+local em `useLastVisit`

**Files:**
- Modify: `src/hooks/useLastVisit.ts`
- Create: `src/hooks/__tests__/useLastVisit.test.ts`

- [ ] **Step 1: Escrever teste primeiro**

Create `src/hooks/__tests__/useLastVisit.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useLastVisit } from '../useLastVisit';

const mockedUseAuth = vi.mocked(useAuth);
const mockedFrom = vi.mocked(supabase.from);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  mockedUseAuth.mockReset();
  mockedFrom.mockReset();
  localStorage.clear();
});

describe('useLastVisit', () => {
  it('returns null when no user and no localStorage', () => {
    mockedUseAuth.mockReturnValue({ user: null } as ReturnType<typeof useAuth>);
    const { result } = renderHook(() => useLastVisit(), { wrapper });
    expect(result.current.lastVisitIso).toBeNull();
    expect(result.current.minutesSinceLastVisit).toBeNull();
  });

  it('falls back to localStorage when no user', () => {
    const iso = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h atrás
    localStorage.setItem('dashboardLastVisit', iso);
    mockedUseAuth.mockReturnValue({ user: null } as ReturnType<typeof useAuth>);
    const { result } = renderHook(() => useLastVisit(), { wrapper });
    expect(result.current.lastVisitIso).toBe(iso);
    expect(result.current.minutesSinceLastVisit).toBeGreaterThanOrEqual(60);
  });

  it('queries previous visit when user present', async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-1' },
    } as ReturnType<typeof useAuth>);

    const serverIso = new Date(Date.now() - 120 * 60_000).toISOString();
    const maybeSingle = vi.fn().mockResolvedValue({ data: { visited_at: serverIso } });
    const rangeFn = vi.fn().mockReturnValue({ maybeSingle });
    const orderFn = vi.fn().mockReturnValue({ range: rangeFn });
    const eqFn = vi.fn().mockReturnValue({ order: orderFn });
    const selectFn = vi.fn().mockReturnValue({ eq: eqFn });
    mockedFrom.mockReturnValue({ select: selectFn } as unknown as ReturnType<typeof supabase.from>);

    const { result } = renderHook(() => useLastVisit(), { wrapper });

    await waitFor(() => expect(result.current.lastVisitIso).toBe(serverIso));
    expect(result.current.minutesSinceLastVisit).toBeGreaterThanOrEqual(120);
    expect(mockedFrom).toHaveBeenCalledWith('dashboard_visits');
    expect(eqFn).toHaveBeenCalledWith('user_id', 'user-1');
    expect(rangeFn).toHaveBeenCalledWith(1, 1);
  });

  it('server visit wins over localStorage when both available', async () => {
    const localIso = new Date(Date.now() - 30 * 60_000).toISOString();
    const serverIso = new Date(Date.now() - 180 * 60_000).toISOString();
    localStorage.setItem('dashboardLastVisit', localIso);
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-2' },
    } as ReturnType<typeof useAuth>);

    const maybeSingle = vi.fn().mockResolvedValue({ data: { visited_at: serverIso } });
    const rangeFn = vi.fn().mockReturnValue({ maybeSingle });
    const orderFn = vi.fn().mockReturnValue({ range: rangeFn });
    const eqFn = vi.fn().mockReturnValue({ order: orderFn });
    const selectFn = vi.fn().mockReturnValue({ eq: eqFn });
    mockedFrom.mockReturnValue({ select: selectFn } as unknown as ReturnType<typeof supabase.from>);

    const { result } = renderHook(() => useLastVisit(), { wrapper });
    await waitFor(() => expect(result.current.lastVisitIso).toBe(serverIso));
  });

  it('falls back to localStorage when server returns null', async () => {
    const localIso = new Date(Date.now() - 45 * 60_000).toISOString();
    localStorage.setItem('dashboardLastVisit', localIso);
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-3' },
    } as ReturnType<typeof useAuth>);

    const maybeSingle = vi.fn().mockResolvedValue({ data: null });
    const rangeFn = vi.fn().mockReturnValue({ maybeSingle });
    const orderFn = vi.fn().mockReturnValue({ range: rangeFn });
    const eqFn = vi.fn().mockReturnValue({ order: orderFn });
    const selectFn = vi.fn().mockReturnValue({ eq: eqFn });
    mockedFrom.mockReturnValue({ select: selectFn } as unknown as ReturnType<typeof supabase.from>);

    const { result } = renderHook(() => useLastVisit(), { wrapper });
    // Espera resolver a query (resolve com null), depois cai pro local
    await waitFor(() => expect(result.current.lastVisitIso).toBe(localIso));
  });
});
```

- [ ] **Step 2: Rodar test e ver falhar**

```bash
bun run vitest run src/hooks/__tests__/useLastVisit.test.ts
```

Expected: FAIL — hook ainda é local-only.

- [ ] **Step 3: Refatorar `src/hooks/useLastVisit.ts`**

```ts
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';

const STORAGE_KEY = 'dashboardLastVisit';
const MIN_SESSION_MS = 5 * 60 * 1000; // 5min — evita F5 anular deltas

export interface UseLastVisitReturn {
  lastVisitIso: string | null;
  minutesSinceLastVisit: number | null;
}

/**
 * Híbrido:
 * 1. Query server `dashboard_visits` pegando 2ª visita mais recente (antes da atual)
 * 2. localStorage como fallback offline / pre-deploy / sem auth
 * 3. Server wins quando ambos disponíveis (cross-device confiável)
 *
 * Escreve nova visita no unmount: server (best-effort) + local (sempre).
 * Só escreve se sessão durou ≥ 5min (F5 não apaga deltas).
 */
export function useLastVisit(): UseLastVisitReturn {
  const { user } = useAuth();
  const [localSnapshot] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
  });
  const mountedAtRef = useRef<number>(Date.now());

  const { data: serverIso } = useQuery({
    queryKey: ['dashboard', 'previous-visit', user?.id],
    queryFn: async (): Promise<string | null> => {
      if (!user?.id) return null;
      const { data } = await supabase
        .from('dashboard_visits')
        .select('visited_at')
        .eq('user_id', user.id)
        .order('visited_at', { ascending: false })
        .range(1, 1) // segunda mais recente
        .maybeSingle();
      const row = data as { visited_at?: string } | null;
      return row?.visited_at ?? null;
    },
    enabled: !!user?.id,
    staleTime: Infinity, // só roda no mount
  });

  // Escreve no unmount se sessão duradoura
  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return;
      const sessionDuration = Date.now() - mountedAtRef.current;
      if (sessionDuration < MIN_SESSION_MS) return;

      const now = new Date().toISOString();
      const sessionMinutes = Math.floor(sessionDuration / 60_000);

      // local (sempre)
      localStorage.setItem(STORAGE_KEY, now);

      // server (best-effort, não bloqueia)
      if (user?.id) {
        void supabase
          .from('dashboard_visits')
          .insert({
            user_id: user.id,
            visited_at: now,
            session_minutes: sessionMinutes,
          });
      }
    };
  }, [user?.id]);

  const lastVisitIso = serverIso ?? localSnapshot;
  const minutesSinceLastVisit = lastVisitIso
    ? Math.floor((Date.now() - new Date(lastVisitIso).getTime()) / 60_000)
    : null;

  return { lastVisitIso, minutesSinceLastVisit };
}
```

- [ ] **Step 4: Rodar tests**

```bash
bun run vitest run src/hooks/__tests__/useLastVisit.test.ts
```

Expected: PASS 5/5.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useLastVisit.ts src/hooks/__tests__/useLastVisit.test.ts
git commit -m "feat(dashboard): useLastVisit hybrid (server dashboard_visits + localStorage fallback) + 5 tests"
```

---

# Phase 4 · Final

### Task 4: Validação + push

- [ ] **Step 1: Full suite**

```bash
bun run vitest run
bunx eslint src/hooks/useLastVisit.ts src/integrations/supabase/types-dashboard-visits.ts
bun run build
```

Expected:
- Tests: ≥179 pass (174 base + 5 novos)
- Lint zero erros
- Build exit 0

- [ ] **Step 2: Push**

```bash
git push -u origin claude/dashboard-visits
```

- [ ] **Step 3: Abrir PR**

`gh pr create --base main --title "dashboard_visits — persistência server-side + useLastVisit híbrido"`

---

## Critérios "feito"
- [ ] Migration aplica sem erro
- [ ] Tests 179+ pass
- [ ] `useLastVisit` lê server primeiro, cai pra local; escreve ambos no unmount ≥5min
- [ ] Cross-device funciona (manual: logar em 2 browsers, ver lastVisit sincroniza)

## Out-of-scope (por spec §7)
- Geo/IP/UA tracking (PostHog cobre)
- Sync entre tabs (ordering DESC resolve naturalmente)
- Cleanup automático (sob demanda quando crescer)
- Edge Function (client INSERT direto cobre)
- Backfill histórico

## Pós-deploy
- Aplicar migration no Supabase
- `useLastVisit` passa a popular server gradualmente; análises ficam disponíveis após algumas semanas
