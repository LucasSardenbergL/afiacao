# Dashboard Principal V3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o `StaffHome` inline em `src/pages/Index.tsx` por um novo `<StaffDashboard />` com auto-detect de persona, suporte multi-empresa via switcher + 'Todas', brief híbrido (PriorityCard + DeltasStrip) e cockpit denso de 6 zonas (Vendas, Estoque, Reposição, Financeiro, Tintométrico, Sistema) com realtime e telemetria PostHog dedicada.

**Architecture:** Sub-árvore isolada em `src/components/dashboard/`. `DashboardShell` provê contextos de persona + empresa + last-visit. Zonas são componentes independentes com seu próprio hook de query e channel realtime. Pure functions de persona detection / priority scoring / delta aggregation testadas isoladamente com vitest. Componentes React validados manualmente em rota dev `/dashboard-v3` removida antes do PR.

**Tech Stack:** React 18 + TypeScript + react-query + Supabase Realtime + posthog-js + shadcn/ui + Tailwind tokens v3 + vitest.

**Spec base:** [docs/superpowers/specs/2026-05-16-dashboard-principal-v3-design.md](../specs/2026-05-16-dashboard-principal-v3-design.md)

---

## File Structure

**Novos arquivos (33):**

```
src/components/dashboard/
  StaffDashboard.tsx              # Entry da árvore staff (substitui StaffHome em Index.tsx)
  DashboardShell.tsx              # Provê contextos persona + empresa + lastVisit
  DashboardFooter.tsx             # Echo chips + hints de atalho
  BriefZone.tsx                   # Hero: PriorityCard + DeltasStrip
  PriorityCard.tsx                # 1 ação prioritária
  DeltasStrip.tsx                 # Faixa "desde sua última visita…"
  CockpitGrid.tsx                 # Grid 3/3/2/1, ordena zonas por persona
  PersonaSwitcherChip.tsx         # Chip clicável com popover (troca persona)
  CompanyChip.tsx                 # Chip echo do CompanySwitcher
  cockpit/
    CockpitCard.tsx               # Wrapper visual
    CockpitCardHeader.tsx         # Header + LiveBadge
    CockpitKpiRow.tsx             # 3 KPIs em row
    CockpitTopList.tsx            # Top-3 lista densa
    CockpitCardFooter.tsx         # "Abrir cockpit →"
    CockpitCardError.tsx          # Estado de erro com retry
    CockpitCardSkeleton.tsx       # Skeleton interno
  zones/
    VendasZone.tsx
    EstoqueZone.tsx
    ReposicaoZone.tsx
    FinanceiroZone.tsx
    TintometricoZone.tsx
    SistemaZone.tsx

src/contexts/
  DashboardPersonaContext.tsx     # Persona + setOverride

src/hooks/
  usePersona.ts                   # Resolve persona, expõe override
  useDashboardCompany.ts          # mode: 'single' | 'all'
  useRequiredCompany.ts           # Adapter: páginas legadas
  useLastVisit.ts                 # localStorage + flush on unmount
  useSalesOnlyRestriction.ts      # Extraído de AppShell.tsx

src/hooks/dashboard/
  useCockpitChannel.ts            # Wrapper Supabase Realtime + LiveBadge state
  useVendasZone.ts
  useEstoqueZone.ts
  useReposicaoZone.ts
  useFinanceiroZone.ts
  useTintometricoZone.ts
  useSistemaZone.ts
  useBriefDeltas.ts               # Compara estado atual vs lastVisit

src/lib/dashboard/
  persona-detect.ts               # Função pura inferPersona(signals)
  persona-config.ts               # zoneOrder + priorityZones por persona
  priority-rules.ts               # Types + helpers de PriorityItem
  route-tracker.ts                # useRouteTracker + storage
  delta-aggregators.ts            # Funções puras de aggregation
  zone-meta.ts                    # Ícones/labels/captions por zona
```

**Tests adjacentes (`__tests__/` ao lado):**

```
src/lib/dashboard/__tests__/
  persona-detect.test.ts
  persona-config.test.ts
  delta-aggregators.test.ts
  route-tracker.test.ts
src/hooks/__tests__/
  usePersona.test.ts
  useDashboardCompany.test.ts
```

**Arquivos a editar (5):**

```
src/contexts/CompanyContext.tsx          # Aceita sentinela 'all'
src/components/shell/CompanySwitcher.tsx # Adiciona opção "Todas as empresas"
src/components/AppShell.tsx              # Monta useRouteTracker(); remove useSalesOnlyRestriction local
src/pages/Index.tsx                      # Troca StaffHome inline por <StaffDashboard />
src/App.tsx                              # (Dev-only) rota /dashboard-v3 temporária; removida antes do PR
```

---

# Phase 0 · Setup e foundation

### Task 1: Criar branch + dev route + smoke

**Files:**
- Modify: `src/App.tsx`
- Create: `src/components/dashboard/StaffDashboard.tsx`

- [ ] **Step 1:** Verificar branch ativo

```bash
git status --short
git branch --show-current
```

Expected: branch `claude/naughty-aryabhata-8da946` (ou nova branch derivada). Working tree clean.

- [ ] **Step 2:** Criar arquivo placeholder do `StaffDashboard`

Create `src/components/dashboard/StaffDashboard.tsx`:

```tsx
export function StaffDashboard() {
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold">Dashboard V3 — placeholder</h1>
      <p className="text-sm text-muted-foreground mt-2">
        Em construção. Cada task vai preencher uma peça.
      </p>
    </div>
  );
}
```

- [ ] **Step 3:** Adicionar rota dev temporária `/dashboard-v3` em `src/App.tsx`

Encontrar o bloco de rotas autenticadas (perto da linha 183 onde está `<Route index element={<Index />} />`) e adicionar imediatamente abaixo:

```tsx
<Route path="dashboard-v3" element={<StaffDashboard />} />
```

E no topo do arquivo, adicionar o import:

```tsx
import { StaffDashboard } from '@/components/dashboard/StaffDashboard';
```

> Nota: esse import é direto (não lazy) porque é dev-only e tem zero impacto em bundle de produção (vai ser removido antes do PR).

- [ ] **Step 4:** Rodar dev server e validar

Run: `bun dev`
Acessar: `http://localhost:8080/dashboard-v3`
Expected: ver o título "Dashboard V3 — placeholder" e o texto descritivo.

- [ ] **Step 5:** Commit

```bash
git add src/App.tsx src/components/dashboard/StaffDashboard.tsx
git commit -m "feat(dashboard-v3): bootstrap placeholder + dev route /dashboard-v3"
```

---

# Phase 1 · Multi-empresa (CompanyContext + 'Todas')

### Task 2: Estender `CompanyContext` para aceitar sentinela `'all'`

**Files:**
- Modify: `src/contexts/CompanyContext.tsx`

- [ ] **Step 1:** Substituir o conteúdo de `src/contexts/CompanyContext.tsx`

```tsx
import { createContext, useContext, useState, ReactNode } from 'react';

export type Company = 'colacor' | 'oben' | 'colacor_sc';
export type CompanySelection = Company | 'all';

interface CompanyInfo {
  id: Company;
  name: string;
  shortName: string;
  regime: 'simples' | 'presumido' | 'real';
}

export const COMPANIES: Record<Company, CompanyInfo> = {
  colacor: { id: 'colacor', name: 'Afiação Colacor', shortName: 'Colacor', regime: 'presumido' },
  oben: { id: 'oben', name: 'Oben Comercial', shortName: 'Oben', regime: 'presumido' },
  colacor_sc: { id: 'colacor_sc', name: 'Colacor SC', shortName: 'Colacor SC', regime: 'simples' },
};

export const ALL_COMPANIES: Company[] = ['oben', 'colacor', 'colacor_sc'];

function isValidSelection(v: string | null): v is CompanySelection {
  return v === 'colacor' || v === 'oben' || v === 'colacor_sc' || v === 'all';
}

interface CompanyContextType {
  /** Empresa única ativa (fallback canônico quando seleção = 'all'). */
  activeCompany: Company;
  /** Seleção bruta — pode ser 'all'. Use selection ao invés de activeCompany em consumidores multi-empresa. */
  selection: CompanySelection;
  setSelection: (s: CompanySelection) => void;
  /** Compat: aceita só Company (Selecionar empresa única). */
  setActiveCompany: (company: Company) => void;
  companyInfo: CompanyInfo;
}

const CompanyContext = createContext<CompanyContextType | undefined>(undefined);

export const useCompany = () => {
  const context = useContext(CompanyContext);
  if (!context) {
    throw new Error('useCompany must be used within a CompanyProvider');
  }
  return context;
};

export const CompanyProvider = ({ children }: { children: ReactNode }) => {
  const [selection, setSelectionState] = useState<CompanySelection>(() => {
    const stored = localStorage.getItem('activeCompany');
    return isValidSelection(stored) ? stored : 'colacor';
  });

  const setSelection = (s: CompanySelection) => {
    setSelectionState(s);
    localStorage.setItem('activeCompany', s);
  };

  const setActiveCompany = (company: Company) => setSelection(company);

  // activeCompany é sempre uma Company concreta — para legado, em modo 'all' devolve o último single conhecido.
  const lastSingle: Company =
    selection !== 'all' ? selection : (() => {
      const stored = localStorage.getItem('activeCompanyLastSingle');
      return isValidSelection(stored) && stored !== 'all' ? stored : 'colacor';
    })();

  // Sempre que selection vira single, lembra qual foi (pra resolver fallback em 'all').
  if (selection !== 'all' && typeof window !== 'undefined') {
    localStorage.setItem('activeCompanyLastSingle', selection);
  }

  return (
    <CompanyContext.Provider value={{
      activeCompany: lastSingle,
      selection,
      setSelection,
      setActiveCompany,
      companyInfo: COMPANIES[lastSingle],
    }}>
      {children}
    </CompanyContext.Provider>
  );
};
```

- [ ] **Step 2:** Verificar que existing consumers não quebram

Run: `bun lint`
Expected: zero erros. `activeCompany` continua sendo `Company` (não `CompanySelection`), então todo código que faz `if (activeCompany === 'oben')` continua válido.

- [ ] **Step 3:** Rodar typecheck via build dry

Run: `bun build` (ou pular se for muito lento; lint cobre).
Expected: build passa sem erros de tipo.

- [ ] **Step 4:** Commit

```bash
git add src/contexts/CompanyContext.tsx
git commit -m "feat(company): aceita sentinela 'all' como CompanySelection; mantém activeCompany retrocompatível"
```

---

### Task 3: Adicionar opção "Todas as empresas" ao `CompanySwitcher`

**Files:**
- Modify: `src/components/shell/CompanySwitcher.tsx`

- [ ] **Step 1:** Substituir o conteúdo de `src/components/shell/CompanySwitcher.tsx`

```tsx
import { Check, ChevronsUpDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ALL_COMPANIES, COMPANIES, useCompany, type Company, type CompanySelection } from '@/contexts/CompanyContext';
import { cn } from '@/lib/utils';
import { track } from '@/lib/analytics';

const COMPANY_VISUAL: Record<Company, { letter: string; tokenVar: string; hint: string }> = {
  colacor:    { letter: 'C', tokenVar: '--company-colacor', hint: 'Indústria' },
  oben:       { letter: 'O', tokenVar: '--company-oben',    hint: 'Distribuidora' },
  colacor_sc: { letter: 'S', tokenVar: '--company-sc',      hint: 'Serviços' },
};

function CompanyMonogram({
  id,
  size = 20,
  withRingOnHover = false,
}: {
  id: Company;
  size?: number;
  withRingOnHover?: boolean;
}) {
  const v = COMPANY_VISUAL[id];
  return (
    <div
      className={cn(
        'rounded-md flex items-center justify-center font-semibold text-white shrink-0 transition-all',
        'shadow-[inset_0_1px_0_hsl(0_0%_100%/0.18),0_1px_2px_hsl(0_0%_0%/0.06)]',
        withRingOnHover && 'group-hover:ring-2 group-hover:ring-offset-1 group-hover:ring-offset-background',
      )}
      style={{
        width: size,
        height: size,
        backgroundColor: `hsl(var(${v.tokenVar}))`,
        fontSize: size <= 20 ? 11 : 13,
        letterSpacing: '-0.02em',
        // @ts-expect-error CSS var inline
        '--tw-ring-color': `hsl(var(${v.tokenVar}) / 0.4)`,
      }}
      aria-hidden
    >
      {v.letter}
    </div>
  );
}

function TripleMonogram({ size = 20 }: { size?: number }) {
  // Monograma triplo "Grupo" — 3 segmentos verticais com as cores das empresas.
  return (
    <div
      className="rounded-md overflow-hidden shrink-0 flex shadow-[inset_0_1px_0_hsl(0_0%_100%/0.18),0_1px_2px_hsl(0_0%_0%/0.06)]"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {ALL_COMPANIES.map((id) => (
        <div
          key={id}
          className="flex-1 h-full"
          style={{ backgroundColor: `hsl(var(${COMPANY_VISUAL[id].tokenVar}))` }}
        />
      ))}
    </div>
  );
}

export function CompanySwitcher() {
  const { selection, setSelection, companyInfo } = useCompany();

  const triggerLabel = selection === 'all' ? 'Todas' : companyInfo.shortName;
  const triggerVisual = selection === 'all'
    ? <TripleMonogram size={20} />
    : <CompanyMonogram id={selection} size={20} withRingOnHover />;

  const handleSelect = (next: CompanySelection) => {
    if (next !== selection) {
      track('company.changed', { from: selection, to: next });
    }
    setSelection(next);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="group inline-flex items-center gap-2 h-8 px-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          {triggerVisual}
          <span className="hidden sm:inline">{triggerLabel}</span>
          <ChevronsUpDown className="w-3 h-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
          Empresa ativa
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => handleSelect('all')}
          className="group flex items-center gap-3 py-2"
        >
          <TripleMonogram size={28} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">Todas as empresas</div>
            <div className="text-[11px] text-muted-foreground truncate">
              Grupo Colacor · agregado
            </div>
          </div>
          <Check className={cn('w-4 h-4', selection === 'all' ? 'opacity-100 text-foreground' : 'opacity-0')} />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {ALL_COMPANIES.map((id) => {
          const info = COMPANIES[id];
          const v = COMPANY_VISUAL[id];
          const active = id === selection;
          return (
            <DropdownMenuItem
              key={id}
              onClick={() => handleSelect(id)}
              className="group flex items-center gap-3 py-2"
            >
              <CompanyMonogram id={id} size={28} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{info.shortName}</div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {v.hint} · regime {info.regime}
                </div>
              </div>
              <Check className={cn('w-4 h-4', active ? 'opacity-100 text-foreground' : 'opacity-0')} />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 2:** Validar visualmente

Run: `bun dev` (se não estiver rodando) e abrir qualquer rota staff (`/admin`).
Expected: switcher mostra "Todas as empresas" no topo da lista com monograma triplo (3 segmentos coloridos). Clicar nele troca o trigger pra "Todas" + TripleMonogram. Clicar de volta em "Colacor" volta normal.

- [ ] **Step 3:** Commit

```bash
git add src/components/shell/CompanySwitcher.tsx
git commit -m "feat(switcher): adiciona opção 'Todas as empresas' com monograma triplo"
```

---

### Task 4: Criar hook `useDashboardCompany`

**Files:**
- Create: `src/hooks/useDashboardCompany.ts`
- Test: `src/hooks/__tests__/useDashboardCompany.test.ts`

- [ ] **Step 1:** Escrever o teste primeiro

Create `src/hooks/__tests__/useDashboardCompany.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ALL_COMPANIES } from '@/contexts/CompanyContext';

vi.mock('@/contexts/CompanyContext', async () => {
  const actual = await vi.importActual<typeof import('@/contexts/CompanyContext')>('@/contexts/CompanyContext');
  return { ...actual, useCompany: vi.fn() };
});

import { useCompany } from '@/contexts/CompanyContext';
import { useDashboardCompany } from '../useDashboardCompany';

const mockedUseCompany = vi.mocked(useCompany);

describe('useDashboardCompany', () => {
  beforeEach(() => mockedUseCompany.mockReset());

  it('returns single mode when selection is a Company', () => {
    mockedUseCompany.mockReturnValue({
      activeCompany: 'oben',
      selection: 'oben',
      setSelection: vi.fn(),
      setActiveCompany: vi.fn(),
      companyInfo: { id: 'oben', name: 'Oben', shortName: 'Oben', regime: 'presumido' },
    });
    const { result } = renderHook(() => useDashboardCompany());
    expect(result.current.mode).toBe('single');
    expect(result.current.companies).toEqual(['oben']);
    expect(result.current.primary).toBe('oben');
  });

  it('returns all mode when selection is "all"', () => {
    mockedUseCompany.mockReturnValue({
      activeCompany: 'colacor',
      selection: 'all',
      setSelection: vi.fn(),
      setActiveCompany: vi.fn(),
      companyInfo: { id: 'colacor', name: 'Colacor', shortName: 'Colacor', regime: 'presumido' },
    });
    const { result } = renderHook(() => useDashboardCompany());
    expect(result.current.mode).toBe('all');
    expect(result.current.companies).toEqual(ALL_COMPANIES);
    expect(result.current.primary).toBe('colacor');
  });
});
```

- [ ] **Step 2:** Rodar teste pra ver falhar

Run: `bun test src/hooks/__tests__/useDashboardCompany.test.ts`
Expected: FAIL — hook não existe.

- [ ] **Step 3:** Implementar o hook

Create `src/hooks/useDashboardCompany.ts`:

```ts
import { useMemo } from 'react';
import { ALL_COMPANIES, useCompany, type Company } from '@/contexts/CompanyContext';

export type DashboardCompanyMode = 'single' | 'all';

export interface UseDashboardCompanyReturn {
  /** 'single' = filtrar por 1 empresa. 'all' = agregar 3 empresas. */
  mode: DashboardCompanyMode;
  /** Empresas que a zona deve consultar. Em 'all' = todas; em 'single' = [selecionada]. */
  companies: Company[];
  /** Empresa canônica para KPIs que não podem somar (ex: status de fechamento). */
  primary: Company;
}

export function useDashboardCompany(): UseDashboardCompanyReturn {
  const { selection, activeCompany } = useCompany();

  return useMemo(() => {
    if (selection === 'all') {
      return { mode: 'all', companies: ALL_COMPANIES, primary: activeCompany };
    }
    return { mode: 'single', companies: [selection], primary: selection };
  }, [selection, activeCompany]);
}
```

- [ ] **Step 4:** Rodar testes

Run: `bun test src/hooks/__tests__/useDashboardCompany.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5:** Commit

```bash
git add src/hooks/useDashboardCompany.ts src/hooks/__tests__/useDashboardCompany.test.ts
git commit -m "feat(dashboard): useDashboardCompany hook com mode single|all"
```

---

### Task 5: Criar `useRequiredCompany` adapter para páginas legadas

**Files:**
- Create: `src/hooks/useRequiredCompany.ts`

- [ ] **Step 1:** Criar o hook

Create `src/hooks/useRequiredCompany.ts`:

```ts
import { useCompany, type Company } from '@/contexts/CompanyContext';
import { logger } from '@/lib/logger';

/**
 * Páginas que ainda não suportam modo 'all' usam esse adapter.
 * Devolve sempre uma Company concreta (cai no último single ativo se selection='all').
 * Em dev, loga warning quando o fallback é acionado pra facilitar identificar páginas a migrar.
 */
export function useRequiredCompany(): Company {
  const { selection, activeCompany } = useCompany();

  if (selection === 'all' && import.meta.env.DEV) {
    logger.warn('useRequiredCompany: selection=all, caindo pra activeCompany', { activeCompany });
  }

  return activeCompany;
}
```

- [ ] **Step 2:** Validar typecheck

Run: `bun lint`
Expected: zero erros.

- [ ] **Step 3:** Commit

```bash
git add src/hooks/useRequiredCompany.ts
git commit -m "feat(dashboard): useRequiredCompany adapter para páginas legadas que não suportam 'all'"
```

---

# Phase 2 · Persona infrastructure

### Task 6: Extrair `useSalesOnlyRestriction` de `AppShell.tsx`

**Files:**
- Create: `src/hooks/useSalesOnlyRestriction.ts`
- Modify: `src/components/AppShell.tsx`

- [ ] **Step 1:** Criar arquivo do hook

Create `src/hooks/useSalesOnlyRestriction.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';

/**
 * Retorna true se o CPF do usuário está na lista `sales_only_cpfs` da company_config.
 * Extraído de AppShell.tsx pra ser reusado por usePersona e outros lugares.
 */
export function useSalesOnlyRestriction(): boolean {
  const { user } = useAuth();

  const { data: salesOnlyCpfs } = useQuery({
    queryKey: ['config', 'sales_only_cpfs'],
    queryFn: async () => {
      const { data } = await supabase
        .from('company_config')
        .select('value')
        .eq('key', 'sales_only_cpfs')
        .maybeSingle();
      return data?.value ? (JSON.parse(data.value) as string[]) : [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: userDoc } = useQuery({
    queryKey: ['profile', 'document', user?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('document')
        .eq('user_id', user!.id)
        .maybeSingle();
      return data?.document?.replace(/\D/g, '') || null;
    },
    enabled: !!user?.id,
    staleTime: 5 * 60 * 1000,
  });

  if (!salesOnlyCpfs || !userDoc) return false;
  return salesOnlyCpfs.includes(userDoc);
}
```

- [ ] **Step 2:** Remover a função local de `src/components/AppShell.tsx`

Em `AppShell.tsx`, remover **toda a função** `function useSalesOnlyRestriction()` (linhas 151–183 aprox).

- [ ] **Step 3:** Adicionar import no topo de `AppShell.tsx`

```tsx
import { useSalesOnlyRestriction } from '@/hooks/useSalesOnlyRestriction';
```

Os 2 call-sites (`AppShell.tsx:358` e `AppShell.tsx:663`) já chamam `useSalesOnlyRestriction()` — agora vem do hook importado.

- [ ] **Step 4:** Validar

Run: `bun lint` e `bun dev` (acessar uma rota staff, confirmar sidebar continua igual).
Expected: zero erros; sidebar idêntica.

- [ ] **Step 5:** Commit

```bash
git add src/hooks/useSalesOnlyRestriction.ts src/components/AppShell.tsx
git commit -m "refactor(appshell): extrai useSalesOnlyRestriction pra hook reusável"
```

---

### Task 7: Criar `route-tracker.ts` (storage + hook)

**Files:**
- Create: `src/lib/dashboard/route-tracker.ts`
- Test: `src/lib/dashboard/__tests__/route-tracker.test.ts`

- [ ] **Step 1:** Escrever teste primeiro

Create `src/lib/dashboard/__tests__/route-tracker.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { incrementRouteVisit, getRouteCounts, clearRouteCounts, classifyPath } from '../route-tracker';

describe('classifyPath', () => {
  it('classifies known prefixes', () => {
    expect(classifyPath('/admin/reposicao/sessao')).toBe('/admin/reposicao');
    expect(classifyPath('/admin/reposicao/sessao/pedidos')).toBe('/admin/reposicao');
    expect(classifyPath('/financeiro/cockpit')).toBe('/financeiro');
    expect(classifyPath('/admin/estoque/picking')).toBe('/admin/estoque');
    expect(classifyPath('/recebimento')).toBe('/recebimento');
    expect(classifyPath('/tintometrico/catalogo')).toBe('/tintometrico');
    expect(classifyPath('/sales/new')).toBe('/sales');
  });

  it('returns null for unknown paths', () => {
    expect(classifyPath('/profile')).toBeNull();
    expect(classifyPath('/')).toBeNull();
  });
});

describe('route counts storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts empty', () => {
    expect(getRouteCounts()).toEqual({});
  });

  it('increments visit and stores timestamp', () => {
    const before = Date.now();
    incrementRouteVisit('/admin/reposicao');
    incrementRouteVisit('/admin/reposicao');
    incrementRouteVisit('/financeiro');
    const counts = getRouteCounts();
    expect(counts['/admin/reposicao'].count).toBe(2);
    expect(counts['/financeiro'].count).toBe(1);
    expect(counts['/admin/reposicao'].lastSeenIso).toBeDefined();
    expect(new Date(counts['/admin/reposicao'].lastSeenIso).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('expires entries older than 30 days', () => {
    const expiredIso = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    localStorage.setItem(
      'dashboardRouteCounts',
      JSON.stringify({
        '/financeiro': { count: 5, lastSeenIso: expiredIso },
        '/admin/estoque': { count: 3, lastSeenIso: new Date().toISOString() },
      }),
    );
    incrementRouteVisit('/admin/estoque');
    const counts = getRouteCounts();
    expect(counts['/financeiro']).toBeUndefined();
    expect(counts['/admin/estoque'].count).toBe(4);
  });

  it('clearRouteCounts removes all entries', () => {
    incrementRouteVisit('/admin/reposicao');
    clearRouteCounts();
    expect(getRouteCounts()).toEqual({});
  });

  it('ignores unknown paths in increment', () => {
    incrementRouteVisit('/profile');
    expect(getRouteCounts()).toEqual({});
  });
});
```

- [ ] **Step 2:** Rodar e ver falhar

Run: `bun test src/lib/dashboard/__tests__/route-tracker.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3:** Implementar `route-tracker.ts`

Create `src/lib/dashboard/route-tracker.ts`:

```ts
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const STORAGE_KEY = 'dashboardRouteCounts';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d

/** Prefixos conhecidos que mapeiam pra personas operacionais. */
export const TRACKED_PREFIXES = [
  '/admin/reposicao',
  '/admin/estoque',
  '/recebimento',
  '/financeiro',
  '/tintometrico',
  '/sales',
] as const;

export type TrackedPrefix = typeof TRACKED_PREFIXES[number];

export type RouteCounts = Record<string, { count: number; lastSeenIso: string }>;

/** Classifica um pathname em um dos prefixos conhecidos, ou null se não rastreado. */
export function classifyPath(pathname: string): TrackedPrefix | null {
  for (const prefix of TRACKED_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return prefix;
    }
  }
  return null;
}

function readStorage(): RouteCounts {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RouteCounts) : {};
  } catch {
    return {};
  }
}

function pruneExpired(counts: RouteCounts): RouteCounts {
  const now = Date.now();
  const result: RouteCounts = {};
  for (const [prefix, entry] of Object.entries(counts)) {
    const age = now - new Date(entry.lastSeenIso).getTime();
    if (age <= TTL_MS) result[prefix] = entry;
  }
  return result;
}

function writeStorage(counts: RouteCounts): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(counts));
  } catch {
    /* quota/private mode — silenciar */
  }
}

export function getRouteCounts(): RouteCounts {
  return pruneExpired(readStorage());
}

export function incrementRouteVisit(pathname: string): void {
  const prefix = classifyPath(pathname);
  if (!prefix) return;
  const current = pruneExpired(readStorage());
  const existing = current[prefix];
  current[prefix] = {
    count: (existing?.count ?? 0) + 1,
    lastSeenIso: new Date().toISOString(),
  };
  writeStorage(current);
}

export function clearRouteCounts(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

/** Hook montado no AppShell que incrementa contagem em cada navegação. */
export function useRouteTracker(): void {
  const location = useLocation();
  useEffect(() => {
    incrementRouteVisit(location.pathname);
  }, [location.pathname]);
}
```

- [ ] **Step 4:** Rodar testes

Run: `bun test src/lib/dashboard/__tests__/route-tracker.test.ts`
Expected: PASS (todos).

- [ ] **Step 5:** Commit

```bash
git add src/lib/dashboard/route-tracker.ts src/lib/dashboard/__tests__/route-tracker.test.ts
git commit -m "feat(dashboard): route-tracker.ts + tests (localStorage 30d TTL)"
```

---

### Task 8: Montar `useRouteTracker` no `AppShell`

**Files:**
- Modify: `src/components/AppShell.tsx`

- [ ] **Step 1:** Adicionar import no topo

```tsx
import { useRouteTracker } from '@/lib/dashboard/route-tracker';
```

- [ ] **Step 2:** Chamar dentro do componente exported `AppShell`

Encontrar `export function AppShell({ children }: { children: React.ReactNode }) {` (perto da linha 729) e adicionar como **primeira linha** do corpo da função:

```tsx
useRouteTracker();
```

- [ ] **Step 3:** Validar manualmente

Run: `bun dev`
Acessar `/admin/reposicao/sessao`, depois `/financeiro/cockpit`, depois recarregar dashboard.
Abrir DevTools > Application > Local Storage e procurar chave `dashboardRouteCounts`.
Expected: chave existe com objeto contendo `'/admin/reposicao'` e `'/financeiro'` com contagem ≥1.

- [ ] **Step 4:** Commit

```bash
git add src/components/AppShell.tsx
git commit -m "feat(appshell): monta useRouteTracker pra contar visitas por prefixo"
```

---

### Task 9: Criar `persona-config.ts` (zoneOrder + priorityZones)

**Files:**
- Create: `src/lib/dashboard/persona-config.ts`
- Test: `src/lib/dashboard/__tests__/persona-config.test.ts`

- [ ] **Step 1:** Escrever teste

Create `src/lib/dashboard/__tests__/persona-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PERSONAS, PERSONA_CONFIG, ZONES } from '../persona-config';

describe('persona-config', () => {
  it('every persona has zoneOrder covering all 6 zones', () => {
    for (const persona of PERSONAS) {
      const config = PERSONA_CONFIG[persona];
      expect(config.zoneOrder).toHaveLength(ZONES.length);
      expect(new Set(config.zoneOrder)).toEqual(new Set(ZONES));
    }
  });

  it('every persona has at least 1 priorityZone', () => {
    for (const persona of PERSONAS) {
      expect(PERSONA_CONFIG[persona].priorityZones.length).toBeGreaterThan(0);
    }
  });

  it('priorityZones are subsets of zoneOrder', () => {
    for (const persona of PERSONAS) {
      const config = PERSONA_CONFIG[persona];
      const set = new Set(config.zoneOrder);
      for (const z of config.priorityZones) expect(set.has(z)).toBe(true);
    }
  });
});
```

- [ ] **Step 2:** Rodar e ver falhar

Run: `bun test src/lib/dashboard/__tests__/persona-config.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3:** Implementar `persona-config.ts`

Create `src/lib/dashboard/persona-config.ts`:

```ts
export const ZONES = ['vendas', 'estoque', 'reposicao', 'financeiro', 'tintometrico', 'sistema'] as const;
export type ZoneId = typeof ZONES[number];

export const PERSONAS = [
  'vendedor',
  'gestor',
  'comprador',
  'estoque',
  'financeiro',
  'tintometrico',
  'master',
  'geral',
] as const;
export type Persona = typeof PERSONAS[number];

export interface PersonaConfig {
  /** Ordem dos cards no CockpitGrid pra essa persona. */
  zoneOrder: ZoneId[];
  /** Zonas que contribuem candidatos pro PriorityCard. */
  priorityZones: ZoneId[];
  /** Label humano. */
  label: string;
  /** Caption mostrada no chip ("Recomendado pra ..."). */
  description: string;
}

export const PERSONA_CONFIG: Record<Persona, PersonaConfig> = {
  vendedor: {
    zoneOrder:     ['vendas', 'sistema', 'reposicao', 'estoque', 'financeiro', 'tintometrico'],
    priorityZones: ['vendas', 'sistema'],
    label: 'Vendedor',
    description: 'Pipeline de vendas, carteira de clientes e agenda do dia.',
  },
  gestor: {
    zoneOrder:     ['vendas', 'financeiro', 'sistema', 'reposicao', 'estoque', 'tintometrico'],
    priorityZones: ['vendas', 'financeiro', 'sistema'],
    label: 'Gestor comercial',
    description: 'Meta, performance da equipe, saúde financeira.',
  },
  comprador: {
    zoneOrder:     ['reposicao', 'estoque', 'sistema', 'vendas', 'financeiro', 'tintometrico'],
    priorityZones: ['reposicao', 'estoque'],
    label: 'Comprador',
    description: 'Sugestões de compra, alertas de mercado, recebimento.',
  },
  estoque: {
    zoneOrder:     ['estoque', 'reposicao', 'vendas', 'sistema', 'financeiro', 'tintometrico'],
    priorityZones: ['estoque', 'reposicao'],
    label: 'Estoque',
    description: 'Picking FEFO, NF a conferir, recebimentos do dia.',
  },
  financeiro: {
    zoneOrder:     ['financeiro', 'vendas', 'sistema', 'reposicao', 'estoque', 'tintometrico'],
    priorityZones: ['financeiro'],
    label: 'Financeiro',
    description: 'Aging, conciliação, fluxo projetado, fechamento.',
  },
  tintometrico: {
    zoneOrder:     ['tintometrico', 'estoque', 'vendas', 'sistema', 'reposicao', 'financeiro'],
    priorityZones: ['tintometrico', 'estoque'],
    label: 'Tintométrico',
    description: 'Fórmulas, SKUs Oben, importações e erros.',
  },
  master: {
    zoneOrder:     ['vendas', 'estoque', 'reposicao', 'financeiro', 'tintometrico', 'sistema'],
    priorityZones: ['vendas', 'estoque', 'reposicao', 'financeiro', 'tintometrico', 'sistema'],
    label: 'Master',
    description: 'Visão consolidada das 3 empresas, todos os módulos.',
  },
  geral: {
    zoneOrder:     ['vendas', 'estoque', 'reposicao', 'financeiro', 'tintometrico', 'sistema'],
    priorityZones: ['vendas', 'estoque', 'reposicao', 'financeiro', 'tintometrico', 'sistema'],
    label: 'Geral',
    description: 'Sem persona definida — todos os módulos com peso igual.',
  },
};
```

- [ ] **Step 4:** Rodar testes

Run: `bun test src/lib/dashboard/__tests__/persona-config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5:** Commit

```bash
git add src/lib/dashboard/persona-config.ts src/lib/dashboard/__tests__/persona-config.test.ts
git commit -m "feat(dashboard): persona-config com 8 personas, ZoneId enum, zoneOrder + priorityZones"
```

---

### Task 10: Criar `persona-detect.ts` (função pura)

**Files:**
- Create: `src/lib/dashboard/persona-detect.ts`
- Test: `src/lib/dashboard/__tests__/persona-detect.test.ts`

- [ ] **Step 1:** Escrever teste

Create `src/lib/dashboard/__tests__/persona-detect.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { inferPersona, type PersonaSignals } from '../persona-detect';

const baseSignals: PersonaSignals = {
  override: null,
  role: 'employee',
  commercialRole: null,
  isSalesOnly: false,
  routeCounts: {},
};

describe('inferPersona', () => {
  it('override always wins', () => {
    const r = inferPersona({ ...baseSignals, override: 'financeiro', role: 'master', commercialRole: 'super_admin' });
    expect(r.persona).toBe('financeiro');
    expect(r.source).toBe('manual');
  });

  it('salesOnly CPF → vendedor (beats commercial_role)', () => {
    const r = inferPersona({ ...baseSignals, isSalesOnly: true, commercialRole: 'gerencial' });
    expect(r.persona).toBe('vendedor');
    expect(r.source).toBe('sales_only');
  });

  it('commercial_role operacional → vendedor', () => {
    const r = inferPersona({ ...baseSignals, commercialRole: 'operacional' });
    expect(r.persona).toBe('vendedor');
    expect(r.source).toBe('commercial_role');
  });

  it('commercial_role gerencial → gestor', () => {
    const r = inferPersona({ ...baseSignals, commercialRole: 'gerencial' });
    expect(r.persona).toBe('gestor');
    expect(r.source).toBe('commercial_role');
  });

  it('commercial_role estrategico → master', () => {
    const r = inferPersona({ ...baseSignals, commercialRole: 'estrategico' });
    expect(r.persona).toBe('master');
    expect(r.source).toBe('commercial_role');
  });

  it('commercial_role super_admin → master', () => {
    const r = inferPersona({ ...baseSignals, commercialRole: 'super_admin' });
    expect(r.persona).toBe('master');
    expect(r.source).toBe('commercial_role');
  });

  it('heuristic: 50% reposicao → comprador', () => {
    const r = inferPersona({
      ...baseSignals,
      routeCounts: {
        '/admin/reposicao': { count: 60, lastSeenIso: new Date().toISOString() },
        '/financeiro':     { count: 40, lastSeenIso: new Date().toISOString() },
      },
    });
    expect(r.persona).toBe('comprador');
    expect(r.source).toBe('inference');
  });

  it('heuristic: 50% estoque + recebimento → estoque', () => {
    const r = inferPersona({
      ...baseSignals,
      routeCounts: {
        '/admin/estoque': { count: 30, lastSeenIso: new Date().toISOString() },
        '/recebimento':   { count: 25, lastSeenIso: new Date().toISOString() },
        '/sales':         { count: 45, lastSeenIso: new Date().toISOString() },
      },
    });
    expect(r.persona).toBe('estoque');
    expect(r.source).toBe('inference');
  });

  it('not enough visits → default (master if master role)', () => {
    const r = inferPersona({
      ...baseSignals,
      role: 'master',
      routeCounts: {
        '/admin/reposicao': { count: 5, lastSeenIso: new Date().toISOString() },
      },
    });
    expect(r.persona).toBe('master');
    expect(r.source).toBe('default');
  });

  it('not enough visits + no role → geral', () => {
    const r = inferPersona({
      ...baseSignals,
      role: 'employee',
    });
    expect(r.persona).toBe('geral');
    expect(r.source).toBe('default');
  });

  it('below 40% threshold → default even with enough visits', () => {
    const r = inferPersona({
      ...baseSignals,
      role: 'employee',
      routeCounts: {
        '/admin/reposicao': { count: 4, lastSeenIso: new Date().toISOString() },
        '/financeiro':      { count: 4, lastSeenIso: new Date().toISOString() },
        '/admin/estoque':   { count: 4, lastSeenIso: new Date().toISOString() },
      },
    });
    expect(r.persona).toBe('geral');
    expect(r.source).toBe('default');
  });
});
```

- [ ] **Step 2:** Rodar e ver falhar

Run: `bun test src/lib/dashboard/__tests__/persona-detect.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3:** Implementar `persona-detect.ts`

Create `src/lib/dashboard/persona-detect.ts`:

```ts
import type { Persona } from './persona-config';
import type { RouteCounts } from './route-tracker';
import type { CommercialRole } from '@/hooks/useCommercialRole';
import type { AppRole } from '@/contexts/AuthContext';

export type PersonaSource = 'manual' | 'commercial_role' | 'sales_only' | 'inference' | 'default';

export interface PersonaSignals {
  override: Persona | null;
  role: AppRole | null;
  commercialRole: CommercialRole | null;
  isSalesOnly: boolean;
  routeCounts: RouteCounts;
}

export interface InferPersonaResult {
  persona: Persona;
  source: PersonaSource;
}

const HEURISTIC_MIN_VISITS = 10;
const HEURISTIC_MIN_RATIO = 0.4;

const PREFIX_TO_PERSONA: Record<string, Persona> = {
  '/admin/reposicao': 'comprador',
  '/admin/estoque':   'estoque',
  '/recebimento':     'estoque',
  '/financeiro':      'financeiro',
  '/tintometrico':    'tintometrico',
  '/sales':           'vendedor',
};

export function inferPersona(signals: PersonaSignals): InferPersonaResult {
  // 1. Override manual sempre vence
  if (signals.override) {
    return { persona: signals.override, source: 'manual' };
  }

  // 2. Sales-only CPF → vendedor (mais específico que commercial_role)
  if (signals.isSalesOnly) {
    return { persona: 'vendedor', source: 'sales_only' };
  }

  // 3. commercial_role
  switch (signals.commercialRole) {
    case 'operacional': return { persona: 'vendedor', source: 'commercial_role' };
    case 'gerencial':   return { persona: 'gestor', source: 'commercial_role' };
    case 'estrategico': return { persona: 'master', source: 'commercial_role' };
    case 'super_admin': return { persona: 'master', source: 'commercial_role' };
  }

  // 4. Heurística por prefixo de uso
  const total = Object.values(signals.routeCounts).reduce((sum, e) => sum + e.count, 0);
  if (total >= HEURISTIC_MIN_VISITS) {
    // Agregar contagens por persona (estoque/recebimento contam pra mesma persona)
    const byPersona: Record<string, number> = {};
    for (const [prefix, entry] of Object.entries(signals.routeCounts)) {
      const persona = PREFIX_TO_PERSONA[prefix];
      if (!persona) continue;
      byPersona[persona] = (byPersona[persona] ?? 0) + entry.count;
    }

    let topPersona: Persona | null = null;
    let topCount = 0;
    for (const [persona, count] of Object.entries(byPersona)) {
      if (count > topCount) {
        topPersona = persona as Persona;
        topCount = count;
      }
    }

    if (topPersona && topCount / total >= HEURISTIC_MIN_RATIO) {
      return { persona: topPersona, source: 'inference' };
    }
  }

  // 5. Default
  if (signals.role === 'master') return { persona: 'master', source: 'default' };
  return { persona: 'geral', source: 'default' };
}
```

- [ ] **Step 4:** Rodar testes

Run: `bun test src/lib/dashboard/__tests__/persona-detect.test.ts`
Expected: PASS (todos).

- [ ] **Step 5:** Commit

```bash
git add src/lib/dashboard/persona-detect.ts src/lib/dashboard/__tests__/persona-detect.test.ts
git commit -m "feat(dashboard): persona-detect com regras override > sales_only > commercial_role > heurística > default"
```

---

### Task 11: Criar `DashboardPersonaContext`

**Files:**
- Create: `src/contexts/DashboardPersonaContext.tsx`

- [ ] **Step 1:** Criar o contexto

Create `src/contexts/DashboardPersonaContext.tsx`:

```tsx
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Persona } from '@/lib/dashboard/persona-config';
import type { PersonaSource } from '@/lib/dashboard/persona-detect';

const STORAGE_KEY = 'dashboardPersonaOverride';

interface DashboardPersonaCtx {
  persona: Persona;
  source: PersonaSource;
  override: Persona | null;
  setOverride: (p: Persona) => void;
  clearOverride: () => void;
}

const Ctx = createContext<DashboardPersonaCtx | null>(null);

export function useDashboardPersonaContext(): DashboardPersonaCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDashboardPersonaContext deve ser usado dentro de DashboardPersonaProvider');
  return v;
}

export function DashboardPersonaProvider({
  resolved,
  children,
}: {
  /** Persona resolvida pelo hook usePersona considerando o override atual. */
  resolved: { persona: Persona; source: PersonaSource };
  children: ReactNode;
}) {
  const [override, setOverrideState] = useState<Persona | null>(() => {
    if (typeof window === 'undefined') return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw && typeof raw === 'string' ? (raw as Persona) : null;
  });

  const setOverride = (p: Persona) => {
    setOverrideState(p);
    localStorage.setItem(STORAGE_KEY, p);
  };

  const clearOverride = () => {
    setOverrideState(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  const value = useMemo<DashboardPersonaCtx>(() => ({
    persona: resolved.persona,
    source: resolved.source,
    override,
    setOverride,
    clearOverride,
  }), [resolved.persona, resolved.source, override]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
```

- [ ] **Step 2:** Validar typecheck

Run: `bun lint`
Expected: zero erros.

- [ ] **Step 3:** Commit

```bash
git add src/contexts/DashboardPersonaContext.tsx
git commit -m "feat(dashboard): DashboardPersonaContext com override em localStorage"
```

---

### Task 12: Criar hook `usePersona`

**Files:**
- Create: `src/hooks/usePersona.ts`

- [ ] **Step 1:** Implementar o hook

Create `src/hooks/usePersona.ts`:

```ts
import { useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useCommercialRole } from '@/hooks/useCommercialRole';
import { useSalesOnlyRestriction } from '@/hooks/useSalesOnlyRestriction';
import { getRouteCounts } from '@/lib/dashboard/route-tracker';
import { inferPersona, type InferPersonaResult } from '@/lib/dashboard/persona-detect';
import type { Persona } from '@/lib/dashboard/persona-config';

const STORAGE_KEY = 'dashboardPersonaOverride';

function readOverride(): Persona | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (raw as Persona) : null;
}

/**
 * Resolve persona combinando todos os sinais. Lê override do localStorage diretamente
 * pra evitar dependência circular com DashboardPersonaContext (que envolve em volta).
 * O Context expõe setOverride/clearOverride pra UI.
 */
export function usePersona(): InferPersonaResult {
  const { role } = useAuth();
  const { commercialRole } = useCommercialRole();
  const isSalesOnly = useSalesOnlyRestriction();

  return useMemo(() => {
    return inferPersona({
      override: readOverride(),
      role,
      commercialRole,
      isSalesOnly,
      routeCounts: getRouteCounts(),
    });
    // Re-resolve quando sinais mudam. routeCounts é lido fresh do storage a cada call.
  }, [role, commercialRole, isSalesOnly]);
}
```

- [ ] **Step 2:** Validar

Run: `bun lint`
Expected: zero erros.

- [ ] **Step 3:** Commit

```bash
git add src/hooks/usePersona.ts
git commit -m "feat(dashboard): usePersona hook que combina sinais via inferPersona"
```

---

### Task 13: Criar `PersonaSwitcherChip` (UI do chip com popover)

**Files:**
- Create: `src/components/dashboard/PersonaSwitcherChip.tsx`

- [ ] **Step 1:** Criar o componente

Create `src/components/dashboard/PersonaSwitcherChip.tsx`:

```tsx
import { ChevronDown, Check, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';
import { PERSONAS, PERSONA_CONFIG, type Persona } from '@/lib/dashboard/persona-config';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/utils';

const SOURCE_LABEL: Record<string, string> = {
  manual: 'definido por você',
  commercial_role: 'via cargo comercial',
  sales_only: 'via restrição de CPF',
  inference: 'via inferência de uso',
  default: 'padrão',
};

export function PersonaSwitcherChip() {
  const { persona, source, override, setOverride, clearOverride } = useDashboardPersonaContext();
  const config = PERSONA_CONFIG[persona];

  const handlePick = (next: Persona) => {
    if (next === persona) return;
    track('dashboard.persona.switched', { from: persona, to: next, source: 'manual' });
    setOverride(next);
  };

  const handleClear = () => {
    if (!override) return;
    track('dashboard.persona.switched', { from: persona, to: 'auto', source: 'cleared' });
    clearOverride();
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-background/60 backdrop-blur border border-border/60 text-xs font-medium text-foreground hover:bg-background/80 transition-colors"
        >
          <span className="text-muted-foreground">Visão:</span>
          <span>{config.label}</span>
          <span className="text-muted-foreground">· {SOURCE_LABEL[source]}</span>
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="p-3 border-b border-border">
          <p className="text-xs font-semibold text-foreground">Trocar visão</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            A ordem dos cards e a ação prioritária mudam conforme a persona.
          </p>
        </div>
        <div className="py-1 max-h-72 overflow-y-auto">
          {PERSONAS.map((p) => {
            const c = PERSONA_CONFIG[p];
            const active = p === persona;
            return (
              <button
                key={p}
                onClick={() => handlePick(p)}
                className={cn(
                  'w-full text-left px-3 py-2 hover:bg-muted transition-colors flex items-start gap-2',
                  active && 'bg-muted/60',
                )}
              >
                <Check className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', active ? 'opacity-100' : 'opacity-0')} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground">{c.label}</div>
                  <div className="text-[11px] text-muted-foreground line-clamp-2">{c.description}</div>
                </div>
              </button>
            );
          })}
        </div>
        {override && (
          <div className="p-2 border-t border-border">
            <Button variant="ghost" size="sm" onClick={handleClear} className="w-full text-xs">
              <X className="w-3 h-3 mr-1.5" />
              Limpar override (voltar pro automático)
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2:** Validar

Run: `bun lint`
Expected: zero erros.

- [ ] **Step 3:** Commit

```bash
git add src/components/dashboard/PersonaSwitcherChip.tsx
git commit -m "feat(dashboard): PersonaSwitcherChip com popover de 8 personas + clear override"
```

---

# Phase 3 · Last visit + telemetria helpers

### Task 14: Criar `useLastVisit` hook

**Files:**
- Create: `src/hooks/useLastVisit.ts`

- [ ] **Step 1:** Criar o hook

Create `src/hooks/useLastVisit.ts`:

```ts
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'dashboardLastVisit';

export interface UseLastVisitReturn {
  /** Timestamp ISO da última visita, ou null se nunca visitou. */
  lastVisitIso: string | null;
  /** Idade em minutos desde a última visita (null se primeira visita). */
  minutesSinceLastVisit: number | null;
}

/**
 * Lê a última visita salva, e ao desmontar atualiza o storage com `now`.
 * O refresh no unmount (não no mount) garante que o usuário SEMPRE vê os deltas dele mesmo
 * na próxima abertura.
 */
export function useLastVisit(): UseLastVisitReturn {
  const [snapshot] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
  });

  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return;
      localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    };
  }, []);

  const minutesSinceLastVisit = snapshot
    ? Math.floor((Date.now() - new Date(snapshot).getTime()) / 60_000)
    : null;

  return { lastVisitIso: snapshot, minutesSinceLastVisit };
}
```

- [ ] **Step 2:** Validar

Run: `bun lint`
Expected: zero erros.

- [ ] **Step 3:** Commit

```bash
git add src/hooks/useLastVisit.ts
git commit -m "feat(dashboard): useLastVisit hook (snapshot on mount, flush on unmount)"
```

---

### Task 15: Criar `zone-meta.ts` (ícones/labels/captions reusados)

**Files:**
- Create: `src/lib/dashboard/zone-meta.ts`

- [ ] **Step 1:** Criar o módulo

Create `src/lib/dashboard/zone-meta.ts`:

```ts
import { TrendingUp, Package, ShoppingBag, DollarSign, Palette, Activity, type LucideIcon } from 'lucide-react';
import type { ZoneId } from './persona-config';

export interface ZoneMeta {
  id: ZoneId;
  label: string;
  caption: string;
  icon: LucideIcon;
  cockpitPath: string;
}

export const ZONE_META: Record<ZoneId, ZoneMeta> = {
  vendas:       { id: 'vendas', label: 'Vendas', caption: 'Pipeline operacional', icon: TrendingUp, cockpitPath: '/sales' },
  estoque:      { id: 'estoque', label: 'Estoque', caption: 'Recebimento e picking', icon: Package, cockpitPath: '/admin/estoque/picking' },
  reposicao:    { id: 'reposicao', label: 'Reposição', caption: 'Sugestões e alertas', icon: ShoppingBag, cockpitPath: '/admin/reposicao/sessao' },
  financeiro:   { id: 'financeiro', label: 'Financeiro', caption: 'Aging e fluxo', icon: DollarSign, cockpitPath: '/financeiro/cockpit' },
  tintometrico: { id: 'tintometrico', label: 'Tintométrico', caption: 'Fórmulas Oben', icon: Palette, cockpitPath: '/tintometrico' },
  sistema:      { id: 'sistema', label: 'Sistema', caption: 'Aprovações e integrações', icon: Activity, cockpitPath: '/admin/approvals' },
};
```

- [ ] **Step 2:** Commit

```bash
git add src/lib/dashboard/zone-meta.ts
git commit -m "feat(dashboard): zone-meta com ícones, labels, captions e cockpitPaths"
```

---

# Phase 4 · Brief Zone primitives

### Task 16: Criar `priority-rules.ts` (types + helpers)

**Files:**
- Create: `src/lib/dashboard/priority-rules.ts`

- [ ] **Step 1:** Criar o módulo

Create `src/lib/dashboard/priority-rules.ts`:

```ts
import type { LucideIcon } from 'lucide-react';
import type { ZoneId } from './persona-config';

export type PriorityVariant = 'critical' | 'warning' | 'info' | 'success';

export interface PriorityItem {
  id: string;
  variant: PriorityVariant;
  icon: LucideIcon;
  /** Título curto, 1 linha. */
  title: string;
  /** Descrição curta, 1 linha. */
  description: string;
  cta: { label: string; path: string };
  metadata?: Record<string, unknown>;
}

export interface PriorityCandidate {
  zone: ZoneId;
  score: number;       // 0-100
  item: PriorityItem;
}

export function variantFromScore(score: number): PriorityVariant {
  if (score >= 90) return 'critical';
  if (score >= 60) return 'warning';
  if (score >= 30) return 'info';
  return 'success';
}

/**
 * Escolhe o candidato vencedor entre as zonas relevantes da persona.
 * Tie-breaker: ordem em zoneOrder (vence quem aparece primeiro).
 */
export function pickWinner(
  candidates: PriorityCandidate[],
  personaZoneOrder: ZoneId[],
): PriorityCandidate | null {
  if (candidates.length === 0) return null;
  const indexOf = (z: ZoneId) => personaZoneOrder.indexOf(z);
  const sorted = [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return indexOf(a.zone) - indexOf(b.zone);
  });
  return sorted[0];
}
```

- [ ] **Step 2:** Commit

```bash
git add src/lib/dashboard/priority-rules.ts
git commit -m "feat(dashboard): priority-rules.ts com types + pickWinner helper"
```

---

### Task 17: Criar `PriorityCard` component

**Files:**
- Create: `src/components/dashboard/PriorityCard.tsx`

- [ ] **Step 1:** Criar o componente

Create `src/components/dashboard/PriorityCard.tsx`:

```tsx
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/utils';
import type { PriorityCandidate, PriorityItem, PriorityVariant } from '@/lib/dashboard/priority-rules';

const VARIANT_STYLES: Record<PriorityVariant, { card: string; iconBg: string; iconColor: string }> = {
  critical: {
    card: 'border-status-error-bold/30 bg-status-error-bg/40',
    iconBg: 'bg-status-error-bg',
    iconColor: 'text-status-error-bold',
  },
  warning: {
    card: 'border-status-warning-bold/30 bg-status-warning-bg/40',
    iconBg: 'bg-status-warning-bg',
    iconColor: 'text-status-warning-bold',
  },
  info: {
    card: 'border-status-info-bold/30 bg-status-info-bg/40',
    iconBg: 'bg-status-info-bg',
    iconColor: 'text-status-info-bold',
  },
  success: {
    card: 'border-status-success-bold/30 bg-status-success-bg/40',
    iconBg: 'bg-status-success-bg',
    iconColor: 'text-status-success-bold',
  },
};

export function PriorityCard({ winner }: { winner: PriorityCandidate | null }) {
  const navigate = useNavigate();

  if (!winner) {
    return (
      <Card className="max-w-2xl mx-auto border-status-success-bold/20 bg-status-success-bg/30">
        <CardContent className="p-5 flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl bg-status-success-bg flex items-center justify-center shrink-0">
            <CheckCircle2 className="w-5 h-5 text-status-success-bold" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-display text-base font-medium text-foreground">Tudo sob controle</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Nada que peça sua atenção agora. Confira o cockpit abaixo pra ver o panorama.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const { item, score, zone } = winner;
  const styles = VARIANT_STYLES[item.variant];
  const Icon = item.icon;

  const handleClick = () => {
    track('dashboard.brief.priority_cta_clicked', { zone, score, item_id: item.id });
    navigate(item.cta.path);
  };

  return (
    <Card className={cn('max-w-2xl mx-auto', styles.card)}>
      <CardContent className="p-5">
        <div className="flex items-start gap-4">
          <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center shrink-0', styles.iconBg)}>
            <Icon className={cn('w-5 h-5', styles.iconColor)} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-display text-base font-medium text-foreground">{item.title}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
          </div>
          <Button size="touch" onClick={handleClick} className="shrink-0">
            {item.cta.label}
            <ArrowRight className="w-4 h-4 ml-1.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2:** Validar

Run: `bun lint`
Expected: zero erros (se `<Button size="touch">` não existir ainda, ver Phase 7 — `touch` foi entregue na Fase 4 da auditoria UX e já existe).

- [ ] **Step 3:** Commit

```bash
git add src/components/dashboard/PriorityCard.tsx
git commit -m "feat(dashboard): PriorityCard com 4 variants (critical/warning/info/success) + empty state"
```

---

### Task 18: Criar `delta-aggregators.ts` (funções puras)

**Files:**
- Create: `src/lib/dashboard/delta-aggregators.ts`
- Test: `src/lib/dashboard/__tests__/delta-aggregators.test.ts`

- [ ] **Step 1:** Escrever teste

Create `src/lib/dashboard/__tests__/delta-aggregators.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatTimeSince, formatDeltaBullet, shouldHideStrip } from '../delta-aggregators';

describe('formatTimeSince', () => {
  it('renders minutes', () => {
    expect(formatTimeSince(0)).toBe('há instantes');
    expect(formatTimeSince(1)).toBe('há 1min');
    expect(formatTimeSince(45)).toBe('há 45min');
  });
  it('renders hours', () => {
    expect(formatTimeSince(60)).toBe('há 1h');
    expect(formatTimeSince(125)).toBe('há 2h 5min');
    expect(formatTimeSince(180)).toBe('há 3h');
  });
  it('renders days', () => {
    expect(formatTimeSince(60 * 24)).toBe('há 1d');
    expect(formatTimeSince(60 * 24 * 3 + 60 * 5)).toBe('há 3d');
  });
});

describe('formatDeltaBullet', () => {
  it('positive count', () => {
    expect(formatDeltaBullet({ label: 'pedidos', value: 12 })).toBe('+12 pedidos');
  });
  it('singular', () => {
    expect(formatDeltaBullet({ label: 'NF chegou', value: 1, singular: 'NF chegou' })).toBe('+1 NF chegou');
  });
  it('value 0 returns null (excluded from strip)', () => {
    expect(formatDeltaBullet({ label: 'pedidos', value: 0 })).toBeNull();
  });
  it('formatted currency', () => {
    expect(formatDeltaBullet({ label: 'faturados', value: 47000, format: 'currency' })).toBe('+R$ 47k faturados');
  });
});

describe('shouldHideStrip', () => {
  it('hides when last visit < 30min', () => {
    expect(shouldHideStrip(29)).toBe(true);
    expect(shouldHideStrip(0)).toBe(true);
  });
  it('shows when >= 30min', () => {
    expect(shouldHideStrip(30)).toBe(false);
    expect(shouldHideStrip(120)).toBe(false);
  });
  it('shows when null (first visit)', () => {
    expect(shouldHideStrip(null)).toBe(false);
  });
});
```

- [ ] **Step 2:** Rodar e ver falhar

Run: `bun test src/lib/dashboard/__tests__/delta-aggregators.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3:** Implementar `delta-aggregators.ts`

Create `src/lib/dashboard/delta-aggregators.ts`:

```ts
export interface DeltaSpec {
  label: string;
  value: number;
  singular?: string;
  format?: 'count' | 'currency';
}

const HIDE_THRESHOLD_MIN = 30;

export function formatTimeSince(minutes: number): string {
  if (minutes < 1) return 'há instantes';
  if (minutes < 60) return `há ${minutes}min`;
  const days = Math.floor(minutes / (60 * 24));
  if (days >= 1) return `há ${days}d`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes - hours * 60;
  if (rem === 0) return `há ${hours}h`;
  return `há ${hours}h ${rem}min`;
}

function formatCurrencyCompact(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${Math.round(v / 1_000)}k`;
  return `R$ ${v.toLocaleString('pt-BR')}`;
}

export function formatDeltaBullet(spec: DeltaSpec): string | null {
  if (spec.value === 0) return null;
  if (spec.format === 'currency') {
    return `+${formatCurrencyCompact(spec.value)} ${spec.label}`;
  }
  const label = spec.value === 1 && spec.singular ? spec.singular : spec.label;
  return `+${spec.value} ${label}`;
}

export function shouldHideStrip(minutesSinceLastVisit: number | null): boolean {
  if (minutesSinceLastVisit === null) return false;
  return minutesSinceLastVisit < HIDE_THRESHOLD_MIN;
}
```

- [ ] **Step 4:** Rodar testes

Run: `bun test src/lib/dashboard/__tests__/delta-aggregators.test.ts`
Expected: PASS (todos).

- [ ] **Step 5:** Commit

```bash
git add src/lib/dashboard/delta-aggregators.ts src/lib/dashboard/__tests__/delta-aggregators.test.ts
git commit -m "feat(dashboard): delta-aggregators (formatTimeSince, formatDeltaBullet, shouldHideStrip)"
```

---

### Task 19: Criar `useBriefDeltas` hook (stub inicial; zonas vão alimentar via Phase 6)

**Files:**
- Create: `src/hooks/dashboard/useBriefDeltas.ts`

- [ ] **Step 1:** Criar a estrutura

Create `src/hooks/dashboard/useBriefDeltas.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardCompany } from '@/hooks/useDashboardCompany';
import { useLastVisit } from '@/hooks/useLastVisit';
import type { DeltaSpec } from '@/lib/dashboard/delta-aggregators';
import type { Persona } from '@/lib/dashboard/persona-config';

export interface BriefDelta extends DeltaSpec {
  /** Caminho clicável que filtra pela janela de tempo do delta. */
  path: string;
  /** Identificador pra telemetria. */
  type: string;
}

/**
 * Busca contagens de eventos relevantes desde `lastVisitIso`.
 * Filtragem por persona acontece downstream (DeltasStrip pega só os relevantes).
 *
 * Implementação MVP: queries simples de count.
 * - sales_orders criados desde lastVisit
 * - nfe_recebimentos criados desde lastVisit
 * - eventos_outlier criados desde lastVisit (aumentos)
 * - orders status=orcamento_enviado desde lastVisit
 *
 * Tabelas que não existirem (em ambientes de dev) caem pra count=0 silenciosamente.
 */
export function useBriefDeltas(persona: Persona): { deltas: BriefDelta[]; isLoading: boolean; isEmpty: boolean } {
  const { companies, mode } = useDashboardCompany();
  const { lastVisitIso } = useLastVisit();

  const enabled = !!lastVisitIso;

  const queryKey = ['dashboard', 'brief-deltas', mode, companies.join(','), lastVisitIso ?? 'none'];

  const { data, isLoading } = useQuery({
    queryKey,
    enabled,
    queryFn: async (): Promise<BriefDelta[]> => {
      if (!lastVisitIso) return [];
      const since = lastVisitIso;
      const results: BriefDelta[] = [];

      // sales_orders novos
      try {
        const q = supabase
          .from('sales_orders')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', since);
        const { count } = await q;
        if ((count ?? 0) > 0) {
          results.push({
            type: 'sales_new',
            label: 'pedidos',
            singular: 'pedido',
            value: count ?? 0,
            path: `/sales?createdAfter=${encodeURIComponent(since)}`,
          });
        }
      } catch { /* tabela ausente em dev */ }

      // NF-es novas
      try {
        const q = supabase
          .from('nfe_recebimentos')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', since);
        const { count } = await q;
        if ((count ?? 0) > 0) {
          results.push({
            type: 'nfe_new',
            label: 'NF chegaram',
            singular: 'NF chegou',
            value: count ?? 0,
            path: `/recebimento?createdAfter=${encodeURIComponent(since)}`,
          });
        }
      } catch { /* */ }

      // Eventos outlier (aumentos)
      try {
        const q = supabase
          .from('eventos_outlier')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', since);
        const { count } = await q;
        if ((count ?? 0) > 0) {
          results.push({
            type: 'aumentos_new',
            label: 'aumentos anunciados',
            singular: 'aumento anunciado',
            value: count ?? 0,
            path: `/admin/reposicao/sessao/mercado?createdAfter=${encodeURIComponent(since)}`,
          });
        }
      } catch { /* */ }

      // Orçamentos novos
      try {
        const q = supabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', since)
          .eq('status', 'orcamento_enviado');
        const { count } = await q;
        if ((count ?? 0) > 0) {
          results.push({
            type: 'orcamentos_new',
            label: 'orçamentos enviados',
            singular: 'orçamento enviado',
            value: count ?? 0,
            path: `/admin?status=orcamento_enviado`,
          });
        }
      } catch { /* */ }

      return results;
    },
    staleTime: 60 * 1000,
  });

  const deltas = data ?? [];
  // Cap em 5 bullets (cap conforme spec).
  const capped = deltas.slice(0, 5);
  return { deltas: capped, isLoading: enabled && isLoading, isEmpty: capped.length === 0 };
}
```

- [ ] **Step 2:** Validar

Run: `bun lint`
Expected: zero erros.

- [ ] **Step 3:** Commit

```bash
git add src/hooks/dashboard/useBriefDeltas.ts
git commit -m "feat(dashboard): useBriefDeltas com 4 queries (sales/nfe/aumentos/orçamentos) desde lastVisit"
```

---

### Task 20: Criar `DeltasStrip` component

**Files:**
- Create: `src/components/dashboard/DeltasStrip.tsx`

- [ ] **Step 1:** Criar o componente

Create `src/components/dashboard/DeltasStrip.tsx`:

```tsx
import { useNavigate } from 'react-router-dom';
import { useLastVisit } from '@/hooks/useLastVisit';
import { useBriefDeltas } from '@/hooks/dashboard/useBriefDeltas';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';
import { formatDeltaBullet, formatTimeSince, shouldHideStrip } from '@/lib/dashboard/delta-aggregators';
import { track } from '@/lib/analytics';

export function DeltasStrip() {
  const navigate = useNavigate();
  const { persona } = useDashboardPersonaContext();
  const { lastVisitIso, minutesSinceLastVisit } = useLastVisit();
  const { deltas, isLoading, isEmpty } = useBriefDeltas(persona);

  // Primeiro acesso
  if (!lastVisitIso) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mx-auto max-w-3xl text-center text-xs text-muted-foreground py-2"
      >
        Bem-vindo. Comece pelo cockpit abaixo.
      </div>
    );
  }

  if (shouldHideStrip(minutesSinceLastVisit)) return null;

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl text-center text-xs text-muted-foreground py-2 font-mono opacity-60">
        Calculando deltas…
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="mx-auto max-w-3xl text-center text-xs text-muted-foreground py-2">
        Sem mudanças desde sua última visita ({formatTimeSince(minutesSinceLastVisit ?? 0)}).
      </div>
    );
  }

  const handleClick = (type: string, value: number, path: string) => {
    track('dashboard.brief.delta_clicked', { delta_type: type, count: value });
    navigate(path);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto max-w-4xl text-center text-xs py-2 px-4 overflow-x-auto"
    >
      <span className="text-muted-foreground">
        Desde sua última visita ({formatTimeSince(minutesSinceLastVisit ?? 0)})
      </span>
      {deltas.map((d) => {
        const text = formatDeltaBullet(d);
        if (!text) return null;
        return (
          <span key={d.type} className="inline-flex items-center">
            <span className="text-muted-foreground mx-2">•</span>
            <button
              onClick={() => handleClick(d.type, d.value, d.path)}
              className="font-mono text-foreground hover:underline transition-colors"
            >
              {text}
            </button>
          </span>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2:** Validar

Run: `bun lint`
Expected: zero erros.

- [ ] **Step 3:** Commit

```bash
git add src/components/dashboard/DeltasStrip.tsx
git commit -m "feat(dashboard): DeltasStrip com edge cases (primeiro acesso, <30min hide, empty)"
```

---

### Task 21: Criar `CompanyChip` (echo do switcher dentro do dashboard)

**Files:**
- Create: `src/components/dashboard/CompanyChip.tsx`

- [ ] **Step 1:** Criar o componente

Create `src/components/dashboard/CompanyChip.tsx`:

```tsx
import { ChevronDown, Check } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ALL_COMPANIES, COMPANIES, useCompany, type Company, type CompanySelection } from '@/contexts/CompanyContext';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/utils';

const COLOR_VAR: Record<Company, string> = {
  colacor: '--company-colacor',
  oben: '--company-oben',
  colacor_sc: '--company-sc',
};

export function CompanyChip() {
  const { selection, setSelection } = useCompany();

  const label =
    selection === 'all' ? 'Todas as empresas' : COMPANIES[selection].shortName;

  const handlePick = (next: CompanySelection) => {
    if (next === selection) return;
    track('dashboard.company.switched_from_dashboard', { from: selection, to: next });
    setSelection(next);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-background/60 backdrop-blur border border-border/60 text-xs font-medium text-foreground hover:bg-background/80 transition-colors"
        >
          <span className="text-muted-foreground">Empresa:</span>
          <span>{label}</span>
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <button
          onClick={() => handlePick('all')}
          className={cn(
            'w-full text-left px-2 py-1.5 hover:bg-muted rounded transition-colors flex items-center gap-2',
            selection === 'all' && 'bg-muted/60',
          )}
        >
          <Check className={cn('w-3.5 h-3.5', selection === 'all' ? 'opacity-100' : 'opacity-0')} />
          <div className="flex gap-0.5">
            {ALL_COMPANIES.map((id) => (
              <span key={id} className="w-3 h-3 rounded-sm" style={{ backgroundColor: `hsl(var(${COLOR_VAR[id]}))` }} />
            ))}
          </div>
          <span className="text-sm">Todas as empresas</span>
        </button>
        <div className="my-1 h-px bg-border" />
        {ALL_COMPANIES.map((id) => (
          <button
            key={id}
            onClick={() => handlePick(id)}
            className={cn(
              'w-full text-left px-2 py-1.5 hover:bg-muted rounded transition-colors flex items-center gap-2',
              selection === id && 'bg-muted/60',
            )}
          >
            <Check className={cn('w-3.5 h-3.5', selection === id ? 'opacity-100' : 'opacity-0')} />
            <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: `hsl(var(${COLOR_VAR[id]}))` }} />
            <span className="text-sm">{COMPANIES[id].shortName}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2:** Commit

```bash
git add src/components/dashboard/CompanyChip.tsx
git commit -m "feat(dashboard): CompanyChip (echo do switcher, telemetria from-dashboard)"
```

---

### Task 22: Compor `BriefZone`

**Files:**
- Create: `src/components/dashboard/BriefZone.tsx`

- [ ] **Step 1:** Criar o componente

Create `src/components/dashboard/BriefZone.tsx`:

```tsx
import { PersonaSwitcherChip } from './PersonaSwitcherChip';
import { CompanyChip } from './CompanyChip';
import { PriorityCard } from './PriorityCard';
import { DeltasStrip } from './DeltasStrip';
import type { PriorityCandidate } from '@/lib/dashboard/priority-rules';

export function BriefZone({ winner }: { winner: PriorityCandidate | null }) {
  return (
    <section className="bg-cockpit-hero noise relative overflow-hidden border-b border-border">
      <div className="max-w-7xl mx-auto px-4 lg:px-6 py-8 lg:py-10 space-y-5 relative">
        <div className="flex items-center gap-2 flex-wrap">
          <PersonaSwitcherChip />
          <CompanyChip />
        </div>

        <PriorityCard winner={winner} />

        <DeltasStrip />
      </div>
    </section>
  );
}
```

- [ ] **Step 2:** Validar

Run: `bun lint`
Expected: zero erros.

- [ ] **Step 3:** Commit

```bash
git add src/components/dashboard/BriefZone.tsx
git commit -m "feat(dashboard): BriefZone compõe chips + PriorityCard + DeltasStrip dentro de hero"
```

---

# Phase 5 · Cockpit primitives

### Task 23: Criar `useCockpitChannel` hook

**Files:**
- Create: `src/hooks/dashboard/useCockpitChannel.ts`

- [ ] **Step 1:** Criar o hook

Create `src/hooks/dashboard/useCockpitChannel.ts`:

```ts
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import type { ZoneId } from '@/lib/dashboard/persona-config';

export interface UseCockpitChannelOptions {
  zone: ZoneId;
  table: string;
  /** Filtro Postgres opcional (ex: 'company=eq.oben'). Sem filtro → escuta toda a tabela. */
  filter?: string;
  /** Chaves do React Query a invalidar quando chega evento. */
  queryKeys: readonly (readonly unknown[])[];
}

/**
 * Padrão de realtime do cockpit: subscreve postgres_changes na tabela,
 * invalida queries no evento, expõe estado de conexão pro LiveBadge,
 * instrumenta connect/disconnect na telemetria.
 */
export function useCockpitChannel({ zone, table, filter, queryKeys }: UseCockpitChannelOptions): { isLive: boolean } {
  const queryClient = useQueryClient();
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    const channelName = `dashboard-${zone}-${table}${filter ? `-${filter}` : ''}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) },
        () => {
          queryKeys.forEach((k) => queryClient.invalidateQueries({ queryKey: [...k] }));
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setIsLive(true);
          track('dashboard.realtime.channel_connected', { zone, table });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setIsLive(false);
          track('dashboard.realtime.channel_disconnected', { zone, table });
        }
      });

    return () => {
      supabase.removeChannel(channel);
      setIsLive(false);
    };
    // queryKeys array identity may change; consumers should memoize. Including stringified key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone, table, filter, queryClient]);

  return { isLive };
}
```

- [ ] **Step 2:** Commit

```bash
git add src/hooks/dashboard/useCockpitChannel.ts
git commit -m "feat(dashboard): useCockpitChannel wrapper para Supabase Realtime + telemetria"
```

---

### Task 24: Criar `CockpitCard` + subcomponentes (Header, KpiRow, TopList, Footer, Error, Skeleton)

**Files:**
- Create: `src/components/dashboard/cockpit/CockpitCard.tsx`
- Create: `src/components/dashboard/cockpit/CockpitCardHeader.tsx`
- Create: `src/components/dashboard/cockpit/CockpitKpiRow.tsx`
- Create: `src/components/dashboard/cockpit/CockpitTopList.tsx`
- Create: `src/components/dashboard/cockpit/CockpitCardFooter.tsx`
- Create: `src/components/dashboard/cockpit/CockpitCardError.tsx`
- Create: `src/components/dashboard/cockpit/CockpitCardSkeleton.tsx`

- [ ] **Step 1:** Criar `CockpitCard.tsx`

```tsx
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function CockpitCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Card
      className={cn(
        'flex flex-col h-[320px] overflow-hidden border border-border hover:border-foreground/15 transition-colors',
        className,
      )}
    >
      {children}
    </Card>
  );
}
```

- [ ] **Step 2:** Criar `CockpitCardHeader.tsx`

```tsx
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function CockpitCardHeader({
  icon: Icon,
  title,
  caption,
  isLive,
}: {
  icon: LucideIcon;
  title: string;
  caption: string;
  isLive: boolean;
}) {
  return (
    <header className="flex items-start justify-between px-4 pt-4 pb-3 border-b border-border/60">
      <div className="flex items-start gap-2.5 min-w-0">
        <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4 text-foreground" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground truncate">{title}</h3>
          <p className="text-[11px] text-muted-foreground truncate">{caption}</p>
        </div>
      </div>
      <LiveBadge isLive={isLive} />
    </header>
  );
}

function LiveBadge({ isLive }: { isLive: boolean }) {
  if (!isLive) return null;
  return (
    <span
      aria-label="dados ao vivo"
      className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-status-success-bold shrink-0"
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className={cn('animate-ping-slow absolute inline-flex h-full w-full rounded-full bg-status-success-bold opacity-60')} />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-status-success-bold" />
      </span>
      Live
    </span>
  );
}
```

- [ ] **Step 3:** Criar `CockpitKpiRow.tsx`

```tsx
import { ArrowUp, ArrowDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Company } from '@/contexts/CompanyContext';

export interface KpiSpec {
  label: string;
  value: string;
  /** Delta em % (positivo = ↑ verde, negativo = ↓ vermelho). */
  deltaPct?: number;
  /** Breakdown por empresa (sum). Mostra dots quando informado. */
  breakdown?: { company: Company; share: number }[];
}

const COLOR_VAR: Record<Company, string> = {
  colacor: '--company-colacor',
  oben: '--company-oben',
  colacor_sc: '--company-sc',
};

export function CockpitKpiRow({ kpis }: { kpis: KpiSpec[] }) {
  return (
    <div className="grid grid-cols-3 gap-3 px-4 py-4 border-b border-border/60">
      {kpis.map((k) => (
        <div key={k.label} className="min-w-0">
          <div className="kpi-value text-xl text-foreground truncate" title={k.value}>{k.value}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5 truncate">
            {k.label}
          </div>
          <div className="mt-1.5 flex items-center gap-1">
            {typeof k.deltaPct === 'number' && (
              <span
                className={cn(
                  'inline-flex items-center text-[10px] font-semibold',
                  k.deltaPct >= 0 ? 'text-status-success-bold' : 'text-status-error-bold',
                )}
              >
                {k.deltaPct >= 0 ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />}
                {Math.abs(k.deltaPct).toFixed(0)}%
              </span>
            )}
            {k.breakdown && k.breakdown.length > 0 && (
              <BreakdownDots breakdown={k.breakdown} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function BreakdownDots({ breakdown }: { breakdown: NonNullable<KpiSpec['breakdown']> }) {
  const total = breakdown.reduce((s, b) => s + b.share, 0) || 1;
  const tooltip = breakdown
    .map((b) => `${b.company}: ${Math.round((b.share / total) * 100)}%`)
    .join(' · ');
  return (
    <div className="inline-flex gap-0.5" title={tooltip} aria-label={tooltip}>
      {breakdown.map((b) => (
        <span
          key={b.company}
          className="h-1 rounded-sm"
          style={{
            backgroundColor: `hsl(var(${COLOR_VAR[b.company]}))`,
            width: `${Math.max(6, (b.share / total) * 24)}px`,
          }}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4:** Criar `CockpitTopList.tsx`

```tsx
import { useNavigate } from 'react-router-dom';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { track } from '@/lib/analytics';
import type { ZoneId } from '@/lib/dashboard/persona-config';

export interface TopListItem {
  id: string;
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  path: string;
  itemType: string;
  badge?: { label: string; intent?: 'warning' | 'error' | 'success' | 'info' };
}

const BADGE_CLASS: Record<NonNullable<NonNullable<TopListItem['badge']>['intent']>, string> = {
  warning: 'text-status-warning-bold bg-status-warning-bg',
  error: 'text-status-error-bold bg-status-error-bg',
  success: 'text-status-success-bold bg-status-success-bg',
  info: 'text-status-info-bold bg-status-info-bg',
};

export function CockpitTopList({
  zone,
  items,
  emptyLabel,
}: {
  zone: ZoneId;
  items: TopListItem[];
  emptyLabel: string;
}) {
  const navigate = useNavigate();

  if (items.length === 0) {
    return (
      <div className="flex-1 px-4 py-4 text-center text-xs text-muted-foreground italic">
        {emptyLabel}
      </div>
    );
  }

  return (
    <ul className="flex-1 overflow-y-auto">
      {items.slice(0, 3).map((it) => {
        const Icon = it.icon;
        return (
          <li key={it.id}>
            <button
              onClick={() => {
                track('dashboard.zone.list_item_clicked', { zone, item_type: it.itemType, item_id: it.id });
                navigate(it.path);
              }}
              className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-muted/50 transition-colors border-b border-border/40 last:border-0"
            >
              {Icon && <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-foreground truncate">{it.title}</div>
                {it.subtitle && (
                  <div className="text-[10px] text-muted-foreground truncate">{it.subtitle}</div>
                )}
              </div>
              {it.badge && (
                <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded', BADGE_CLASS[it.badge.intent ?? 'info'])}>
                  {it.badge.label}
                </span>
              )}
              <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 5:** Criar `CockpitCardFooter.tsx`

```tsx
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { track } from '@/lib/analytics';
import type { ZoneId } from '@/lib/dashboard/persona-config';
import type { Persona } from '@/lib/dashboard/persona-config';

export function CockpitCardFooter({
  zone,
  persona,
  label,
  path,
}: {
  zone: ZoneId;
  persona: Persona;
  label: string;
  path: string;
}) {
  const navigate = useNavigate();
  return (
    <footer className="border-t border-border/60">
      <button
        onClick={() => {
          track('dashboard.zone.open_cockpit', { zone, persona });
          navigate(path);
        }}
        className="w-full py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors flex items-center justify-center gap-1.5 group"
      >
        {label}
        <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
      </button>
    </footer>
  );
}
```

- [ ] **Step 6:** Criar `CockpitCardError.tsx`

```tsx
import { AlertTriangle, RefreshCw } from 'lucide-react';

export function CockpitCardError({ onRetry, message }: { onRetry: () => void; message?: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 p-4 text-center">
      <AlertTriangle className="w-5 h-5 text-status-error-bold" />
      <p className="text-xs text-muted-foreground">{message ?? 'Erro ao carregar dados.'}</p>
      <button
        onClick={onRetry}
        className="inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
      >
        <RefreshCw className="w-3 h-3" />
        Tentar novamente
      </button>
    </div>
  );
}
```

- [ ] **Step 7:** Criar `CockpitCardSkeleton.tsx`

```tsx
import { Skeleton } from '@/components/ui/skeleton';

export function CockpitCardSkeleton() {
  return (
    <div className="flex-1 flex flex-col">
      <div className="grid grid-cols-3 gap-3 px-4 py-4 border-b border-border/60">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-2.5 w-12" />
          </div>
        ))}
      </div>
      <div className="flex-1 px-4 py-3 space-y-2">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
      </div>
    </div>
  );
}
```

- [ ] **Step 8:** Validar todos

Run: `bun lint`
Expected: zero erros.

- [ ] **Step 9:** Commit

```bash
git add src/components/dashboard/cockpit/
git commit -m "feat(dashboard): cockpit primitives (Card, Header+LiveBadge, KpiRow+Breakdown, TopList, Footer, Error, Skeleton)"
```

---

# Phase 6 · Zones

Cada zona segue o mesmo padrão: 1 hook em `src/hooks/dashboard/use<Zona>Zone.ts` que devolve `{ kpis, topItems, priority, isLoading, isError, refetch }`, e 1 componente em `src/components/dashboard/zones/<Zona>Zone.tsx` que monta `<CockpitCard>` + subcomponentes.

> **Estratégia para gracioso degradar**: se uma tabela ainda não existir no schema, a query devolve count=0 sem quebrar. Isso é importante porque algumas tabelas (`fin_lancamentos`, `pending_user_approvals`, `sync_logs`) estão marcadas "a confirmar" na spec.

### Task 25: VendasZone (hook + componente)

**Files:**
- Create: `src/hooks/dashboard/useVendasZone.ts`
- Create: `src/components/dashboard/zones/VendasZone.tsx`

- [ ] **Step 1:** Criar o hook

Create `src/hooks/dashboard/useVendasZone.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Package, FileText } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardCompany } from '@/hooks/useDashboardCompany';
import { useCockpitChannel } from '@/hooks/dashboard/useCockpitChannel';
import { variantFromScore, type PriorityCandidate } from '@/lib/dashboard/priority-rules';
import type { KpiSpec } from '@/components/dashboard/cockpit/CockpitKpiRow';
import type { TopListItem } from '@/components/dashboard/cockpit/CockpitTopList';

const fmtBRL = (v: number) => {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${Math.round(v / 1_000)}k`;
  return `R$ ${v.toLocaleString('pt-BR')}`;
};

export function useVendasZone() {
  const { companies, mode } = useDashboardCompany();
  const queryKey = ['dashboard', 'vendas', mode, companies.join(',')];

  const { isLive } = useCockpitChannel({
    zone: 'vendas',
    table: 'sales_orders',
    queryKeys: [queryKey],
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const yesterdayStart = new Date(startOfDay);
      yesterdayStart.setDate(yesterdayStart.getDate() - 1);

      let faturadoHoje = 0;
      let faturadoOntem = 0;
      let pedidosHoje = 0;
      let orcamentosAguardando = 0;

      try {
        // sales_orders hoje
        const { data: hoje } = await supabase
          .from('sales_orders')
          .select('total')
          .gte('created_at', startOfDay.toISOString());
        if (hoje) {
          pedidosHoje = hoje.length;
          faturadoHoje = hoje.reduce((s: number, r: any) => s + Number(r.total ?? 0), 0);
        }

        // sales_orders ontem
        const { data: ontem } = await supabase
          .from('sales_orders')
          .select('total')
          .gte('created_at', yesterdayStart.toISOString())
          .lt('created_at', startOfDay.toISOString());
        if (ontem) {
          faturadoOntem = ontem.reduce((s: number, r: any) => s + Number(r.total ?? 0), 0);
        }
      } catch { /* tabela ausente — devolve 0 */ }

      try {
        const { count } = await supabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'orcamento_enviado');
        orcamentosAguardando = count ?? 0;
      } catch { /* */ }

      // Top-3: pedidos sem ação >24h por valor
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let topItems: TopListItem[] = [];
      try {
        const { data: top } = await supabase
          .from('orders')
          .select('id, total, status, created_at, profiles(name)')
          .eq('status', 'orcamento_enviado')
          .lt('created_at', cutoff)
          .order('total', { ascending: false })
          .limit(3);
        topItems = (top ?? []).map((o: any) => ({
          id: o.id as string,
          icon: FileText,
          title: o.profiles?.name ?? 'Cliente',
          subtitle: `Orçamento ${fmtBRL(Number(o.total ?? 0))} aguardando >24h`,
          path: `/admin/orders/${o.id}`,
          itemType: 'orcamento_pending',
          badge: { label: 'Ação', intent: 'warning' },
        }));
      } catch { /* */ }

      const deltaPct = faturadoOntem > 0
        ? Math.round(((faturadoHoje - faturadoOntem) / faturadoOntem) * 100)
        : undefined;

      return {
        faturadoHoje,
        pedidosHoje,
        orcamentosAguardando,
        deltaPct,
        topItems,
      };
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const kpis: KpiSpec[] = useMemo(() => {
    if (!data) return [];
    return [
      { label: 'Faturado hoje', value: fmtBRL(data.faturadoHoje), deltaPct: data.deltaPct },
      { label: 'Pedidos hoje', value: String(data.pedidosHoje) },
      { label: 'Aguardando', value: String(data.orcamentosAguardando) },
    ];
  }, [data]);

  const priority: PriorityCandidate | null = useMemo(() => {
    if (!data?.topItems?.length) return null;
    const first = data.topItems[0];
    const score = 75; // orçamento >24h = warning
    return {
      zone: 'vendas',
      score,
      item: {
        id: first.id,
        variant: variantFromScore(score),
        icon: FileText,
        title: `Orçamento >24h aguardando — ${first.title}`,
        description: 'Cliente espera resposta. Abrir e aprovar ou recusar.',
        cta: { label: 'Abrir orçamento', path: first.path },
        metadata: { source: 'vendas.orcamento_pending' },
      },
    };
  }, [data]);

  return { kpis, topItems: data?.topItems ?? [], priority, isLoading, isError, refetch, isLive };
}
```

- [ ] **Step 2:** Criar o componente

Create `src/components/dashboard/zones/VendasZone.tsx`:

```tsx
import { CockpitCard } from '../cockpit/CockpitCard';
import { CockpitCardHeader } from '../cockpit/CockpitCardHeader';
import { CockpitKpiRow } from '../cockpit/CockpitKpiRow';
import { CockpitTopList } from '../cockpit/CockpitTopList';
import { CockpitCardFooter } from '../cockpit/CockpitCardFooter';
import { CockpitCardError } from '../cockpit/CockpitCardError';
import { CockpitCardSkeleton } from '../cockpit/CockpitCardSkeleton';
import { useVendasZone } from '@/hooks/dashboard/useVendasZone';
import { ZONE_META } from '@/lib/dashboard/zone-meta';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';

export function VendasZone() {
  const meta = ZONE_META.vendas;
  const { persona } = useDashboardPersonaContext();
  const { kpis, topItems, isLoading, isError, refetch, isLive } = useVendasZone();

  return (
    <CockpitCard>
      <CockpitCardHeader icon={meta.icon} title={meta.label} caption={meta.caption} isLive={isLive} />
      {isLoading && <CockpitCardSkeleton />}
      {isError && <CockpitCardError onRetry={() => refetch()} />}
      {!isLoading && !isError && (
        <>
          <CockpitKpiRow kpis={kpis} />
          <CockpitTopList zone="vendas" items={topItems} emptyLabel="Sem orçamentos aguardando." />
        </>
      )}
      <CockpitCardFooter zone="vendas" persona={persona} label="Abrir vendas" path={meta.cockpitPath} />
    </CockpitCard>
  );
}
```

- [ ] **Step 3:** Validar

Run: `bun lint`
Expected: zero erros.

- [ ] **Step 4:** Commit

```bash
git add src/hooks/dashboard/useVendasZone.ts src/components/dashboard/zones/VendasZone.tsx
git commit -m "feat(dashboard): VendasZone (faturado/pedidos/aguardando + top-3 orçamentos >24h)"
```

---

### Task 26: EstoqueZone

**Files:**
- Create: `src/hooks/dashboard/useEstoqueZone.ts`
- Create: `src/components/dashboard/zones/EstoqueZone.tsx`

- [ ] **Step 1:** Criar o hook

Create `src/hooks/dashboard/useEstoqueZone.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Package, FileCheck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardCompany } from '@/hooks/useDashboardCompany';
import { useCockpitChannel } from '@/hooks/dashboard/useCockpitChannel';
import { variantFromScore, type PriorityCandidate } from '@/lib/dashboard/priority-rules';
import type { KpiSpec } from '@/components/dashboard/cockpit/CockpitKpiRow';
import type { TopListItem } from '@/components/dashboard/cockpit/CockpitTopList';

export function useEstoqueZone() {
  const { companies, mode } = useDashboardCompany();
  const queryKey = ['dashboard', 'estoque', mode, companies.join(',')];

  const { isLive } = useCockpitChannel({
    zone: 'estoque',
    table: 'nfe_recebimentos',
    queryKeys: [queryKey],
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      let nfPendentes = 0;
      let nfPendentes24h = 0;
      let pickingAbertos = 0;
      let pickingFefoVencendo = 0;
      let recebimentosHoje = 0;
      let topItems: TopListItem[] = [];

      try {
        const { data: nf } = await supabase
          .from('nfe_recebimentos')
          .select('id, fornecedor_nome, created_at, status')
          .eq('status', 'pendente');
        if (nf) {
          nfPendentes = nf.length;
          nfPendentes24h = nf.filter((r: any) => r.created_at < cutoff24h).length;
          for (const r of nf.slice(0, 2) as any[]) {
            topItems.push({
              id: r.id,
              icon: FileCheck,
              title: r.fornecedor_nome ?? 'Fornecedor',
              subtitle: 'NF aguardando conferência',
              path: `/admin/estoque/recebimento`,
              itemType: 'nfe_pendente',
              badge: r.created_at < cutoff24h ? { label: '>24h', intent: 'error' } : undefined,
            });
          }
        }
      } catch { /* */ }

      try {
        const { count } = await supabase
          .from('picking_tasks')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pendente');
        pickingAbertos = count ?? 0;
      } catch { /* */ }

      try {
        const today = new Date();
        today.setDate(today.getDate() + 7);
        const { data: fefo } = await supabase
          .from('picking_tasks')
          .select('id, sku_descricao, validade')
          .eq('status', 'pendente')
          .not('validade', 'is', null)
          .lt('validade', today.toISOString());
        if (fefo) {
          pickingFefoVencendo = fefo.length;
          for (const t of fefo.slice(0, 1) as any[]) {
            topItems.push({
              id: t.id,
              icon: Package,
              title: t.sku_descricao ?? 'Item',
              subtitle: 'Picking com validade próxima',
              path: `/admin/estoque/picking`,
              itemType: 'picking_fefo_vencendo',
              badge: { label: 'FEFO', intent: 'warning' },
            });
          }
        }
      } catch { /* */ }

      try {
        const { count } = await supabase
          .from('nfe_recebimentos')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'conferido')
          .gte('updated_at', startOfDay.toISOString());
        recebimentosHoje = count ?? 0;
      } catch { /* */ }

      return { nfPendentes, nfPendentes24h, pickingAbertos, pickingFefoVencendo, recebimentosHoje, topItems };
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const kpis: KpiSpec[] = useMemo(() => {
    if (!data) return [];
    return [
      { label: 'NF pendentes', value: String(data.nfPendentes) },
      { label: 'Picking abertos', value: String(data.pickingAbertos) },
      { label: 'Recebidos hoje', value: String(data.recebimentosHoje) },
    ];
  }, [data]);

  const priority: PriorityCandidate | null = useMemo(() => {
    if (!data) return null;
    if (data.nfPendentes24h > 0) {
      const score = 92;
      return {
        zone: 'estoque',
        score,
        item: {
          id: 'nfe_overdue',
          variant: variantFromScore(score),
          icon: FileCheck,
          title: `${data.nfPendentes24h} NF aguardando conferência há >24h`,
          description: 'Bloqueia entrada no estoque e fluxo financeiro. Conferir agora.',
          cta: { label: 'Conferir NF', path: '/admin/estoque/recebimento' },
          metadata: { source: 'estoque.nfe_overdue', count: data.nfPendentes24h },
        },
      };
    }
    if (data.pickingFefoVencendo > 0) {
      const score = 85;
      return {
        zone: 'estoque',
        score,
        item: {
          id: 'picking_fefo',
          variant: variantFromScore(score),
          icon: Package,
          title: `${data.pickingFefoVencendo} picking com validade próxima`,
          description: 'FEFO — lote vence em até 7 dias. Priorizar separação.',
          cta: { label: 'Abrir picking', path: '/admin/estoque/picking' },
          metadata: { source: 'estoque.picking_fefo' },
        },
      };
    }
    return null;
  }, [data]);

  return { kpis, topItems: data?.topItems ?? [], priority, isLoading, isError, refetch, isLive };
}
```

- [ ] **Step 2:** Criar o componente

Create `src/components/dashboard/zones/EstoqueZone.tsx`:

```tsx
import { CockpitCard } from '../cockpit/CockpitCard';
import { CockpitCardHeader } from '../cockpit/CockpitCardHeader';
import { CockpitKpiRow } from '../cockpit/CockpitKpiRow';
import { CockpitTopList } from '../cockpit/CockpitTopList';
import { CockpitCardFooter } from '../cockpit/CockpitCardFooter';
import { CockpitCardError } from '../cockpit/CockpitCardError';
import { CockpitCardSkeleton } from '../cockpit/CockpitCardSkeleton';
import { useEstoqueZone } from '@/hooks/dashboard/useEstoqueZone';
import { ZONE_META } from '@/lib/dashboard/zone-meta';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';

export function EstoqueZone() {
  const meta = ZONE_META.estoque;
  const { persona } = useDashboardPersonaContext();
  const { kpis, topItems, isLoading, isError, refetch, isLive } = useEstoqueZone();

  return (
    <CockpitCard>
      <CockpitCardHeader icon={meta.icon} title={meta.label} caption={meta.caption} isLive={isLive} />
      {isLoading && <CockpitCardSkeleton />}
      {isError && <CockpitCardError onRetry={() => refetch()} />}
      {!isLoading && !isError && (
        <>
          <CockpitKpiRow kpis={kpis} />
          <CockpitTopList zone="estoque" items={topItems} emptyLabel="Sem pendências de estoque." />
        </>
      )}
      <CockpitCardFooter zone="estoque" persona={persona} label="Abrir estoque" path={meta.cockpitPath} />
    </CockpitCard>
  );
}
```

- [ ] **Step 3:** Commit

```bash
git add src/hooks/dashboard/useEstoqueZone.ts src/components/dashboard/zones/EstoqueZone.tsx
git commit -m "feat(dashboard): EstoqueZone (NF/picking/recebimento + priority NF>24h ou FEFO vencendo)"
```

---

### Task 27: ReposicaoZone

**Files:**
- Create: `src/hooks/dashboard/useReposicaoZone.ts`
- Create: `src/components/dashboard/zones/ReposicaoZone.tsx`

- [ ] **Step 1:** Criar o hook

Create `src/hooks/dashboard/useReposicaoZone.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { ShoppingBag, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardCompany } from '@/hooks/useDashboardCompany';
import { useCockpitChannel } from '@/hooks/dashboard/useCockpitChannel';
import { variantFromScore, type PriorityCandidate } from '@/lib/dashboard/priority-rules';
import type { KpiSpec } from '@/components/dashboard/cockpit/CockpitKpiRow';
import type { TopListItem } from '@/components/dashboard/cockpit/CockpitTopList';

export function useReposicaoZone() {
  const { companies, mode } = useDashboardCompany();
  const queryKey = ['dashboard', 'reposicao', mode, companies.join(',')];

  const { isLive } = useCockpitChannel({
    zone: 'reposicao',
    table: 'pedido_compra_sugerido',
    queryKeys: [queryKey],
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      let sugeridosProntos = 0;
      let alertasAtivos = 0;
      let aumentos7d = 0;
      let topItems: TopListItem[] = [];

      try {
        const { count } = await supabase
          .from('pedido_compra_sugerido')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pronto');
        sugeridosProntos = count ?? 0;
      } catch { /* */ }

      try {
        const { data: alerts, count } = await supabase
          .from('eventos_outlier')
          .select('id, tipo, descricao, severidade', { count: 'exact' })
          .order('created_at', { ascending: false })
          .limit(5);
        alertasAtivos = count ?? 0;
        if (alerts) {
          topItems = alerts.slice(0, 3).map((a: any) => ({
            id: a.id,
            icon: AlertTriangle,
            title: a.descricao ?? a.tipo ?? 'Alerta',
            subtitle: `Severidade ${a.severidade ?? 'média'}`,
            path: '/admin/reposicao/sessao',
            itemType: 'outlier_event',
            badge: a.severidade === 'alta' || a.severidade === 'critica'
              ? { label: a.severidade, intent: 'error' as const }
              : undefined,
          }));
        }
      } catch { /* */ }

      try {
        const { count } = await supabase
          .from('fornecedor_aumento_anunciado')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', sevenDaysAgo);
        aumentos7d = count ?? 0;
      } catch { /* */ }

      return { sugeridosProntos, alertasAtivos, aumentos7d, topItems };
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const kpis: KpiSpec[] = useMemo(() => {
    if (!data) return [];
    return [
      { label: 'Sugeridos prontos', value: String(data.sugeridosProntos) },
      { label: 'Alertas ativos', value: String(data.alertasAtivos) },
      { label: 'Aumentos 7d', value: String(data.aumentos7d) },
    ];
  }, [data]);

  const priority: PriorityCandidate | null = useMemo(() => {
    if (!data) return null;
    if (data.sugeridosProntos > 0) {
      const score = 88;
      return {
        zone: 'reposicao',
        score,
        item: {
          id: 'sugeridos_pronto',
          variant: variantFromScore(score),
          icon: ShoppingBag,
          title: `${data.sugeridosProntos} pedido(s) de compra prontos para aplicar`,
          description: 'Sessão de reposição concluiu sugestões. Revisar e enviar ao Omie.',
          cta: { label: 'Abrir cockpit', path: '/admin/reposicao/sessao' },
          metadata: { source: 'reposicao.sugerido_pronto' },
        },
      };
    }
    return null;
  }, [data]);

  return { kpis, topItems: data?.topItems ?? [], priority, isLoading, isError, refetch, isLive };
}
```

- [ ] **Step 2:** Criar o componente

Create `src/components/dashboard/zones/ReposicaoZone.tsx`:

```tsx
import { CockpitCard } from '../cockpit/CockpitCard';
import { CockpitCardHeader } from '../cockpit/CockpitCardHeader';
import { CockpitKpiRow } from '../cockpit/CockpitKpiRow';
import { CockpitTopList } from '../cockpit/CockpitTopList';
import { CockpitCardFooter } from '../cockpit/CockpitCardFooter';
import { CockpitCardError } from '../cockpit/CockpitCardError';
import { CockpitCardSkeleton } from '../cockpit/CockpitCardSkeleton';
import { useReposicaoZone } from '@/hooks/dashboard/useReposicaoZone';
import { ZONE_META } from '@/lib/dashboard/zone-meta';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';

export function ReposicaoZone() {
  const meta = ZONE_META.reposicao;
  const { persona } = useDashboardPersonaContext();
  const { kpis, topItems, isLoading, isError, refetch, isLive } = useReposicaoZone();

  return (
    <CockpitCard>
      <CockpitCardHeader icon={meta.icon} title={meta.label} caption={meta.caption} isLive={isLive} />
      {isLoading && <CockpitCardSkeleton />}
      {isError && <CockpitCardError onRetry={() => refetch()} />}
      {!isLoading && !isError && (
        <>
          <CockpitKpiRow kpis={kpis} />
          <CockpitTopList zone="reposicao" items={topItems} emptyLabel="Sem alertas ativos." />
        </>
      )}
      <CockpitCardFooter zone="reposicao" persona={persona} label="Abrir reposição" path={meta.cockpitPath} />
    </CockpitCard>
  );
}
```

- [ ] **Step 3:** Commit

```bash
git add src/hooks/dashboard/useReposicaoZone.ts src/components/dashboard/zones/ReposicaoZone.tsx
git commit -m "feat(dashboard): ReposicaoZone (sugeridos/alertas/aumentos + priority sugeridos prontos)"
```

---

### Task 28: FinanceiroZone

**Files:**
- Create: `src/hooks/dashboard/useFinanceiroZone.ts`
- Create: `src/components/dashboard/zones/FinanceiroZone.tsx`

- [ ] **Step 1:** Criar o hook

Create `src/hooks/dashboard/useFinanceiroZone.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { DollarSign, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { getAgingReceber, getTopInadimplentes } from '@/services/financeiroService';
import { useDashboardCompany } from '@/hooks/useDashboardCompany';
import { variantFromScore, type PriorityCandidate } from '@/lib/dashboard/priority-rules';
import type { KpiSpec } from '@/components/dashboard/cockpit/CockpitKpiRow';
import type { TopListItem } from '@/components/dashboard/cockpit/CockpitTopList';

const fmtBRL = (v: number) => {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${Math.round(v / 1_000)}k`;
  return `R$ ${v.toLocaleString('pt-BR')}`;
};

export function useFinanceiroZone() {
  const { mode, primary } = useDashboardCompany();
  const queryKey = ['dashboard', 'financeiro', mode, primary];

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      let aging90 = 0;
      let projecao13Total: number | null = null;
      let confiabilidadePct: number | null = null;
      let topItems: TopListItem[] = [];

      try {
        const aging = await getAgingReceber('all');
        aging90 = Number((aging as any)?.faixa_90_mais ?? (aging as any)?.['90+'] ?? 0);
      } catch { /* */ }

      try {
        const inadList = await getTopInadimplentes('all', 3);
        topItems = (inadList ?? []).map((r: any, i: number) => ({
          id: r.id ?? `inad-${i}`,
          icon: AlertTriangle,
          title: r.cliente_nome ?? r.nome ?? 'Cliente',
          subtitle: `${fmtBRL(Number(r.valor_total ?? r.total ?? 0))} em aberto`,
          path: '/financeiro/cockpit',
          itemType: 'inadimplente',
          badge: { label: 'crítico', intent: 'error' as const },
        }));
      } catch { /* */ }

      try {
        const { data: proj } = await supabase
          .from('fin_projecao_13_semanas')
          .select('valor_projetado')
          .limit(13);
        if (proj) {
          projecao13Total = proj.reduce((s: number, r: any) => s + Number(r.valor_projetado ?? 0), 0);
        }
      } catch { /* */ }

      try {
        const { data: conf } = await supabase
          .from('fin_confiabilidade')
          .select('pct_valor_mapeado, pct_mov_conciliado, fechamento_status')
          .order('mes', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (conf) {
          const pctMap = Number((conf as any).pct_valor_mapeado ?? 0);
          const pctConc = Number((conf as any).pct_mov_conciliado ?? 0);
          const fech = (conf as any).fechamento_status === 'fechado' ? 30 : 0;
          confiabilidadePct = Math.round(pctMap * 0.4 + pctConc * 0.3 + fech);
        }
      } catch { /* */ }

      return { aging90, projecao13Total, confiabilidadePct, topItems };
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });

  const kpis: KpiSpec[] = useMemo(() => {
    if (!data) return [];
    return [
      { label: 'Aging >90d', value: fmtBRL(data.aging90) },
      { label: 'Projeção 13sem', value: data.projecao13Total !== null ? fmtBRL(data.projecao13Total) : '—' },
      { label: 'Confiabilidade', value: data.confiabilidadePct !== null ? `${data.confiabilidadePct}%` : '—' },
    ];
  }, [data]);

  const priority: PriorityCandidate | null = useMemo(() => {
    if (!data) return null;
    if (data.aging90 > 50_000) {
      const score = 90;
      return {
        zone: 'financeiro',
        score,
        item: {
          id: 'aging_critico',
          variant: variantFromScore(score),
          icon: DollarSign,
          title: `${fmtBRL(data.aging90)} em aging >90d`,
          description: 'Inadimplência crítica acima de 90 dias. Acionar cobrança.',
          cta: { label: 'Abrir financeiro', path: '/financeiro/cockpit' },
          metadata: { source: 'financeiro.aging_critico', value: data.aging90 },
        },
      };
    }
    return null;
  }, [data]);

  return { kpis, topItems: data?.topItems ?? [], priority, isLoading, isError, refetch, isLive: false };
}
```

- [ ] **Step 2:** Criar o componente

Create `src/components/dashboard/zones/FinanceiroZone.tsx`:

```tsx
import { CockpitCard } from '../cockpit/CockpitCard';
import { CockpitCardHeader } from '../cockpit/CockpitCardHeader';
import { CockpitKpiRow } from '../cockpit/CockpitKpiRow';
import { CockpitTopList } from '../cockpit/CockpitTopList';
import { CockpitCardFooter } from '../cockpit/CockpitCardFooter';
import { CockpitCardError } from '../cockpit/CockpitCardError';
import { CockpitCardSkeleton } from '../cockpit/CockpitCardSkeleton';
import { useFinanceiroZone } from '@/hooks/dashboard/useFinanceiroZone';
import { ZONE_META } from '@/lib/dashboard/zone-meta';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';

export function FinanceiroZone() {
  const meta = ZONE_META.financeiro;
  const { persona } = useDashboardPersonaContext();
  const { kpis, topItems, isLoading, isError, refetch, isLive } = useFinanceiroZone();

  return (
    <CockpitCard>
      <CockpitCardHeader icon={meta.icon} title={meta.label} caption={meta.caption} isLive={isLive} />
      {isLoading && <CockpitCardSkeleton />}
      {isError && <CockpitCardError onRetry={() => refetch()} />}
      {!isLoading && !isError && (
        <>
          <CockpitKpiRow kpis={kpis} />
          <CockpitTopList zone="financeiro" items={topItems} emptyLabel="Sem inadimplentes críticos." />
        </>
      )}
      <CockpitCardFooter zone="financeiro" persona={persona} label="Abrir financeiro" path={meta.cockpitPath} />
    </CockpitCard>
  );
}
```

- [ ] **Step 3:** Commit

```bash
git add src/hooks/dashboard/useFinanceiroZone.ts src/components/dashboard/zones/FinanceiroZone.tsx
git commit -m "feat(dashboard): FinanceiroZone (aging/projeção/confiabilidade + priority aging>50k)"
```

---

### Task 29: TintometricoZone

**Files:**
- Create: `src/hooks/dashboard/useTintometricoZone.ts`
- Create: `src/components/dashboard/zones/TintometricoZone.tsx`

- [ ] **Step 1:** Criar o hook

Create `src/hooks/dashboard/useTintometricoZone.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Palette, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardCompany } from '@/hooks/useDashboardCompany';
import { useCockpitChannel } from '@/hooks/dashboard/useCockpitChannel';
import { variantFromScore, type PriorityCandidate } from '@/lib/dashboard/priority-rules';
import type { KpiSpec } from '@/components/dashboard/cockpit/CockpitKpiRow';
import type { TopListItem } from '@/components/dashboard/cockpit/CockpitTopList';

const ACCOUNT = 'oben';

export function useTintometricoZone() {
  const { mode, companies } = useDashboardCompany();
  /** Tintométrico é exclusivo da Oben. Mostra dados quando mode=all ou single=oben. */
  const applies = mode === 'all' || companies.includes('oben');

  const queryKey = ['dashboard', 'tintometrico', applies];

  const { isLive } = useCockpitChannel({
    zone: 'tintometrico',
    table: 'tint_importacoes',
    queryKeys: [queryKey],
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    enabled: applies,
    queryFn: async () => {
      let totalFormulas = 0;
      let skusMapped = 0;
      let skusTotal = 0;
      let lastImport: any = null;
      let topItems: TopListItem[] = [];

      try {
        const { count } = await supabase
          .from('tint_formulas')
          .select('id', { count: 'exact', head: true })
          .eq('account', ACCOUNT);
        totalFormulas = count ?? 0;
      } catch { /* */ }

      try {
        const { count: total } = await supabase
          .from('tint_skus')
          .select('id', { count: 'exact', head: true })
          .eq('account', ACCOUNT);
        const { count: mapped } = await supabase
          .from('tint_skus')
          .select('id', { count: 'exact', head: true })
          .eq('account', ACCOUNT)
          .not('omie_product_id', 'is', null);
        skusTotal = total ?? 0;
        skusMapped = mapped ?? 0;
      } catch { /* */ }

      try {
        const { data: imp } = await supabase
          .from('tint_importacoes')
          .select('id, tipo, arquivo_nome, registros_erro, status, created_at')
          .eq('account', ACCOUNT)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        lastImport = imp;
      } catch { /* */ }

      try {
        const { data: errs } = await supabase
          .from('tint_importacoes')
          .select('id, arquivo_nome, registros_erro, created_at')
          .eq('account', ACCOUNT)
          .gt('registros_erro', 0)
          .order('created_at', { ascending: false })
          .limit(3);
        if (errs) {
          topItems = errs.map((e: any) => ({
            id: e.id,
            icon: AlertTriangle,
            title: e.arquivo_nome ?? 'Importação',
            subtitle: `${e.registros_erro} erro(s)`,
            path: '/tintometrico',
            itemType: 'tint_import_error',
            badge: { label: 'erro', intent: 'error' as const },
          }));
        }
      } catch { /* */ }

      return { totalFormulas, skusMapped, skusTotal, lastImport, topItems };
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });

  const kpis: KpiSpec[] = useMemo(() => {
    if (!data) return [];
    return [
      { label: 'Fórmulas', value: String(data.totalFormulas) },
      { label: 'SKUs mapeados', value: `${data.skusMapped}/${data.skusTotal}` },
      { label: 'Última import.', value: data.lastImport?.status ?? '—' },
    ];
  }, [data]);

  const priority: PriorityCandidate | null = useMemo(() => {
    if (!data) return null;
    if (data.lastImport?.registros_erro > 0) {
      const score = 95;
      return {
        zone: 'tintometrico',
        score,
        item: {
          id: 'tint_import_error',
          variant: variantFromScore(score),
          icon: AlertTriangle,
          title: `Última importação com ${data.lastImport.registros_erro} erro(s)`,
          description: `${data.lastImport.arquivo_nome ?? 'Importação'} requer revisão.`,
          cta: { label: 'Abrir tintométrico', path: '/tintometrico' },
          metadata: { source: 'tintometrico.import_error' },
        },
      };
    }
    return null;
  }, [data]);

  return { kpis, topItems: data?.topItems ?? [], priority, isLoading: applies && isLoading, isError, refetch, isLive, applies };
}
```

- [ ] **Step 2:** Criar o componente (com empty state quando não aplica)

Create `src/components/dashboard/zones/TintometricoZone.tsx`:

```tsx
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { CockpitCard } from '../cockpit/CockpitCard';
import { CockpitCardHeader } from '../cockpit/CockpitCardHeader';
import { CockpitKpiRow } from '../cockpit/CockpitKpiRow';
import { CockpitTopList } from '../cockpit/CockpitTopList';
import { CockpitCardFooter } from '../cockpit/CockpitCardFooter';
import { CockpitCardError } from '../cockpit/CockpitCardError';
import { CockpitCardSkeleton } from '../cockpit/CockpitCardSkeleton';
import { useTintometricoZone } from '@/hooks/dashboard/useTintometricoZone';
import { ZONE_META } from '@/lib/dashboard/zone-meta';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';
import { useCompany } from '@/contexts/CompanyContext';

export function TintometricoZone() {
  const meta = ZONE_META.tintometrico;
  const { persona } = useDashboardPersonaContext();
  const { setSelection } = useCompany();
  const navigate = useNavigate();
  const { kpis, topItems, isLoading, isError, refetch, isLive, applies } = useTintometricoZone();

  if (!applies) {
    return (
      <CockpitCard>
        <CockpitCardHeader icon={meta.icon} title={meta.label} caption="Exclusivo Oben" isLive={false} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4 text-center">
          <p className="text-xs text-muted-foreground">
            Tintométrico é exclusivo da Oben. Troque pra ver os dados.
          </p>
          <Button variant="outline" size="sm" onClick={() => setSelection('oben')}>
            Trocar pra Oben
          </Button>
        </div>
        <CockpitCardFooter zone="tintometrico" persona={persona} label="Abrir tintométrico" path={meta.cockpitPath} />
      </CockpitCard>
    );
  }

  return (
    <CockpitCard>
      <CockpitCardHeader icon={meta.icon} title={meta.label} caption={meta.caption} isLive={isLive} />
      {isLoading && <CockpitCardSkeleton />}
      {isError && <CockpitCardError onRetry={() => refetch()} />}
      {!isLoading && !isError && (
        <>
          <CockpitKpiRow kpis={kpis} />
          <CockpitTopList zone="tintometrico" items={topItems} emptyLabel="Sem erros recentes." />
        </>
      )}
      <CockpitCardFooter zone="tintometrico" persona={persona} label="Abrir tintométrico" path={meta.cockpitPath} />
    </CockpitCard>
  );
}
```

- [ ] **Step 3:** Commit

```bash
git add src/hooks/dashboard/useTintometricoZone.ts src/components/dashboard/zones/TintometricoZone.tsx
git commit -m "feat(dashboard): TintometricoZone (Oben-only) com empty state + setSelection CTA"
```

---

### Task 30: SistemaZone

**Files:**
- Create: `src/hooks/dashboard/useSistemaZone.ts`
- Create: `src/components/dashboard/zones/SistemaZone.tsx`

- [ ] **Step 1:** Criar o hook

Create `src/hooks/dashboard/useSistemaZone.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { UserCheck, Activity } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useCockpitChannel } from '@/hooks/dashboard/useCockpitChannel';
import { variantFromScore, type PriorityCandidate } from '@/lib/dashboard/priority-rules';
import type { KpiSpec } from '@/components/dashboard/cockpit/CockpitKpiRow';
import type { TopListItem } from '@/components/dashboard/cockpit/CockpitTopList';

export function useSistemaZone() {
  const queryKey = ['dashboard', 'sistema'];

  const { isLive } = useCockpitChannel({
    zone: 'sistema',
    table: 'profiles',
    filter: 'is_approved=eq.false',
    queryKeys: [queryKey],
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      let aprovacoesPendentes = 0;
      let syncOmie: string | null = null;
      let syncSayerlack: string | null = null;
      let topItems: TopListItem[] = [];

      try {
        const { data: pending, count } = await supabase
          .from('profiles')
          .select('user_id, name, created_at', { count: 'exact' })
          .eq('is_approved', false)
          .order('created_at', { ascending: true })
          .limit(3);
        aprovacoesPendentes = count ?? 0;
        if (pending) {
          topItems = pending.map((p: any) => ({
            id: p.user_id,
            icon: UserCheck,
            title: p.name ?? 'Usuário sem nome',
            subtitle: 'Aguardando liberação',
            path: '/admin/approvals',
            itemType: 'pending_approval',
            badge: { label: 'novo', intent: 'info' as const },
          }));
        }
      } catch { /* */ }

      try {
        const { data: lastOmie } = await supabase
          .from('sync_logs')
          .select('finished_at, status')
          .eq('integration', 'omie')
          .order('finished_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        syncOmie = (lastOmie as any)?.status ?? null;
      } catch { /* tabela ausente */ }

      try {
        const { data: lastSay } = await supabase
          .from('sync_logs')
          .select('finished_at, status')
          .eq('integration', 'sayerlack')
          .order('finished_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        syncSayerlack = (lastSay as any)?.status ?? null;
      } catch { /* */ }

      return { aprovacoesPendentes, syncOmie, syncSayerlack, topItems };
    },
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  });

  const kpis: KpiSpec[] = useMemo(() => {
    if (!data) return [];
    return [
      { label: 'Aprovações', value: String(data.aprovacoesPendentes) },
      { label: 'Sync Omie', value: data.syncOmie ?? '—' },
      { label: 'Sync Sayerlack', value: data.syncSayerlack ?? '—' },
    ];
  }, [data]);

  const priority: PriorityCandidate | null = useMemo(() => {
    if (!data) return null;
    if (data.aprovacoesPendentes >= 3) {
      const score = 70;
      return {
        zone: 'sistema',
        score,
        item: {
          id: 'pending_approvals',
          variant: variantFromScore(score),
          icon: UserCheck,
          title: `${data.aprovacoesPendentes} liberações aguardando`,
          description: 'Novos cadastros sem acesso ainda. Revisar e aprovar.',
          cta: { label: 'Abrir aprovações', path: '/admin/approvals' },
          metadata: { source: 'sistema.pending_approvals' },
        },
      };
    }
    return null;
  }, [data]);

  return { kpis, topItems: data?.topItems ?? [], priority, isLoading, isError, refetch, isLive };
}
```

- [ ] **Step 2:** Criar o componente

Create `src/components/dashboard/zones/SistemaZone.tsx`:

```tsx
import { CockpitCard } from '../cockpit/CockpitCard';
import { CockpitCardHeader } from '../cockpit/CockpitCardHeader';
import { CockpitKpiRow } from '../cockpit/CockpitKpiRow';
import { CockpitTopList } from '../cockpit/CockpitTopList';
import { CockpitCardFooter } from '../cockpit/CockpitCardFooter';
import { CockpitCardError } from '../cockpit/CockpitCardError';
import { CockpitCardSkeleton } from '../cockpit/CockpitCardSkeleton';
import { useSistemaZone } from '@/hooks/dashboard/useSistemaZone';
import { ZONE_META } from '@/lib/dashboard/zone-meta';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';

export function SistemaZone() {
  const meta = ZONE_META.sistema;
  const { persona } = useDashboardPersonaContext();
  const { kpis, topItems, isLoading, isError, refetch, isLive } = useSistemaZone();

  return (
    <CockpitCard>
      <CockpitCardHeader icon={meta.icon} title={meta.label} caption={meta.caption} isLive={isLive} />
      {isLoading && <CockpitCardSkeleton />}
      {isError && <CockpitCardError onRetry={() => refetch()} />}
      {!isLoading && !isError && (
        <>
          <CockpitKpiRow kpis={kpis} />
          <CockpitTopList zone="sistema" items={topItems} emptyLabel="Tudo em dia." />
        </>
      )}
      <CockpitCardFooter zone="sistema" persona={persona} label="Abrir aprovações" path={meta.cockpitPath} />
    </CockpitCard>
  );
}
```

- [ ] **Step 3:** Commit

```bash
git add src/hooks/dashboard/useSistemaZone.ts src/components/dashboard/zones/SistemaZone.tsx
git commit -m "feat(dashboard): SistemaZone (aprovações + sync omie/sayerlack + priority approvals>=3)"
```

---

# Phase 7 · Grid + Shell + wiring

### Task 31: Criar `CockpitGrid`

**Files:**
- Create: `src/components/dashboard/CockpitGrid.tsx`

- [ ] **Step 1:** Criar o componente

Create `src/components/dashboard/CockpitGrid.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { VendasZone } from './zones/VendasZone';
import { EstoqueZone } from './zones/EstoqueZone';
import { ReposicaoZone } from './zones/ReposicaoZone';
import { FinanceiroZone } from './zones/FinanceiroZone';
import { TintometricoZone } from './zones/TintometricoZone';
import { SistemaZone } from './zones/SistemaZone';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';
import { PERSONA_CONFIG, type ZoneId } from '@/lib/dashboard/persona-config';
import { cn } from '@/lib/utils';

const ZONE_COMPONENTS: Record<ZoneId, () => JSX.Element> = {
  vendas: VendasZone,
  estoque: EstoqueZone,
  reposicao: ReposicaoZone,
  financeiro: FinanceiroZone,
  tintometrico: TintometricoZone,
  sistema: SistemaZone,
};

export function CockpitGrid() {
  const { persona } = useDashboardPersonaContext();
  const order = PERSONA_CONFIG[persona].zoneOrder;

  // Refs pros atalhos 1..6 (scroll-to + outline temporário)
  const refs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= 6) {
        const ref = refs.current[n - 1];
        if (!ref) return;
        ref.scrollIntoView({ behavior: 'smooth', block: 'center' });
        ref.classList.add('ring-2', 'ring-foreground/20');
        setTimeout(() => ref?.classList.remove('ring-2', 'ring-foreground/20'), 1200);
      }
    };
    // Atenção: o ShortcutsRegistry filtra inputs; pra 1-6 simples usamos listener direto.
    // Verifica se foco está em input pra não conflitar:
    const guarded = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return handler(e);
      const tag = target.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target.isContentEditable) return;
      handler(e);
    };
    window.addEventListener('keydown', guarded);
    return () => window.removeEventListener('keydown', guarded);
  }, []);

  return (
    <section
      id="cockpit-grid"
      className={cn(
        'max-w-7xl mx-auto px-4 lg:px-6 py-6 lg:py-8',
        'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4',
      )}
    >
      {order.map((zoneId, i) => {
        const Comp = ZONE_COMPONENTS[zoneId];
        return (
          <div key={zoneId} ref={(el) => (refs.current[i] = el)} className="rounded-lg transition-shadow">
            <Comp />
          </div>
        );
      })}
    </section>
  );
}
```

- [ ] **Step 2:** Commit

```bash
git add src/components/dashboard/CockpitGrid.tsx
git commit -m "feat(dashboard): CockpitGrid 3/2/1 col responsivo + atalhos 1..6 pra scroll-to-zone"
```

---

### Task 32: Criar `DashboardFooter`

**Files:**
- Create: `src/components/dashboard/DashboardFooter.tsx`

- [ ] **Step 1:** Criar o componente

Create `src/components/dashboard/DashboardFooter.tsx`:

```tsx
import { Keyboard } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PersonaSwitcherChip } from './PersonaSwitcherChip';
import { CompanyChip } from './CompanyChip';

export function DashboardFooter() {
  return (
    <footer className="border-t border-border mt-2">
      <div className="max-w-7xl mx-auto px-4 lg:px-6 py-3 flex items-center justify-between gap-4 flex-wrap text-xs text-muted-foreground">
        <div className="flex items-center gap-2 flex-wrap">
          <PersonaSwitcherChip />
          <CompanyChip />
        </div>
        <div className="flex items-center gap-3 font-mono text-[11px]">
          <span className="inline-flex items-center gap-1">
            <Keyboard className="w-3 h-3" />
            <kbd className="px-1 rounded bg-muted">?</kbd> atalhos
          </span>
          <span>
            <kbd className="px-1 rounded bg-muted">⌘K</kbd> busca
          </span>
          <span>
            <kbd className="px-1 rounded bg-muted">r</kbd> recarregar
          </span>
          <span>
            <kbd className="px-1 rounded bg-muted">g d</kbd> dashboard
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button disabled className="opacity-50 cursor-not-allowed">
                Personalizar dashboard
              </button>
            </TooltipTrigger>
            <TooltipContent>Em breve</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </footer>
  );
}
```

- [ ] **Step 2:** Commit

```bash
git add src/components/dashboard/DashboardFooter.tsx
git commit -m "feat(dashboard): DashboardFooter com echo de chips + hints de atalho"
```

---

### Task 33: Criar `DashboardShell` (providers + composition)

**Files:**
- Modify: `src/components/dashboard/StaffDashboard.tsx`
- Create: `src/components/dashboard/DashboardShell.tsx`

- [ ] **Step 1:** Criar `DashboardShell`

Create `src/components/dashboard/DashboardShell.tsx`:

```tsx
import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePersona } from '@/hooks/usePersona';
import { DashboardPersonaProvider, useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';
import { useRegisterShortcuts } from '@/components/shell/ShortcutsRegistry';
import { useNavigate } from 'react-router-dom';
import { track } from '@/lib/analytics';
import { useLastVisit } from '@/hooks/useLastVisit';
import { useCompany } from '@/contexts/CompanyContext';
import { BriefZone } from './BriefZone';
import { CockpitGrid } from './CockpitGrid';
import { DashboardFooter } from './DashboardFooter';
import { useVendasZone } from '@/hooks/dashboard/useVendasZone';
import { useEstoqueZone } from '@/hooks/dashboard/useEstoqueZone';
import { useReposicaoZone } from '@/hooks/dashboard/useReposicaoZone';
import { useFinanceiroZone } from '@/hooks/dashboard/useFinanceiroZone';
import { useTintometricoZone } from '@/hooks/dashboard/useTintometricoZone';
import { useSistemaZone } from '@/hooks/dashboard/useSistemaZone';
import { pickWinner } from '@/lib/dashboard/priority-rules';
import { PERSONA_CONFIG, type ZoneId } from '@/lib/dashboard/persona-config';
import type { PriorityCandidate } from '@/lib/dashboard/priority-rules';

export function DashboardShell() {
  const resolved = usePersona();
  return (
    <DashboardPersonaProvider resolved={resolved}>
      <DashboardBody />
    </DashboardPersonaProvider>
  );
}

function DashboardBody() {
  const { persona, source } = useDashboardPersonaContext();
  const { selection } = useCompany();
  const { minutesSinceLastVisit } = useLastVisit();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // dashboard.viewed na montagem
  useEffect(() => {
    track('dashboard.viewed', {
      persona,
      persona_source: source,
      company_mode: selection === 'all' ? 'all' : 'single',
      company_id: selection,
      time_since_last_visit_min: minutesSinceLastVisit,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Coleta priorities das 6 zonas — todos os hooks rodam sempre (ordem fixa hook react)
  const vendas = useVendasZone();
  const estoque = useEstoqueZone();
  const reposicao = useReposicaoZone();
  const financeiro = useFinanceiroZone();
  const tint = useTintometricoZone();
  const sistema = useSistemaZone();

  const zonesByPersona = PERSONA_CONFIG[persona].priorityZones;
  const winner = useMemo<PriorityCandidate | null>(() => {
    const candidates: PriorityCandidate[] = [];
    const byZone: Record<ZoneId, PriorityCandidate | null> = {
      vendas: vendas.priority,
      estoque: estoque.priority,
      reposicao: reposicao.priority,
      financeiro: financeiro.priority,
      tintometrico: tint.priority,
      sistema: sistema.priority,
    };
    for (const z of zonesByPersona) {
      const c = byZone[z];
      if (c) candidates.push(c);
    }
    const w = pickWinner(candidates, PERSONA_CONFIG[persona].zoneOrder);
    if (w) {
      track('dashboard.brief.priority_shown', {
        zone: w.zone,
        variant: w.item.variant,
        score: w.score,
        item_id: w.item.id,
      });
    }
    return w;
  }, [
    persona,
    vendas.priority,
    estoque.priority,
    reposicao.priority,
    financeiro.priority,
    tint.priority,
    sistema.priority,
    zonesByPersona,
  ]);

  // Atalhos: g d, r
  const gPressedAtRef = useRef<number>(0);
  useRegisterShortcuts(useMemo(() => [
    {
      keys: 'g',
      label: 'Início de combo (g d = dashboard)',
      group: 'Dashboard',
      handler: () => { gPressedAtRef.current = Date.now(); },
    },
    {
      keys: 'd',
      label: 'Ir pra dashboard (combo g d)',
      group: 'Dashboard',
      handler: () => {
        if (Date.now() - gPressedAtRef.current < 800) navigate('/');
      },
    },
    {
      keys: 'r',
      label: 'Recarregar dashboard',
      group: 'Dashboard',
      handler: () => { queryClient.invalidateQueries({ queryKey: ['dashboard'] }); },
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [navigate, queryClient]));

  return (
    <div className="min-h-screen flex flex-col">
      <a
        href="#cockpit-grid"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 bg-foreground text-background px-3 py-1.5 rounded text-xs"
      >
        Pular pro cockpit
      </a>
      <BriefZone winner={winner} />
      <main className="flex-1">
        <CockpitGrid />
      </main>
      <DashboardFooter />
    </div>
  );
}
```

- [ ] **Step 2:** Atualizar `StaffDashboard` pra usar `DashboardShell`

Substituir o conteúdo de `src/components/dashboard/StaffDashboard.tsx`:

```tsx
import { DashboardShell } from './DashboardShell';

export function StaffDashboard() {
  return <DashboardShell />;
}
```

- [ ] **Step 3:** Validar dev route

Run: `bun dev` e acessar `http://localhost:8080/dashboard-v3`
Expected:
- Hero com BriefZone (chips persona + empresa, PriorityCard ou success card, DeltasStrip)
- Grid 3 colunas (em wide) com 6 cards
- Footer com chips + hints de atalho
- Console sem erros

- [ ] **Step 4:** Validar atalhos

Pressionar `g` + `d` rapidamente (em qualquer lugar fora de input): deveria navegar pra `/`.
Pressionar `1`..`6` dentro do dashboard: deveria fazer scroll/highlight do card N.
Pressionar `r`: deveria refetch (devtools React Query mostra fetch).

- [ ] **Step 5:** Commit

```bash
git add src/components/dashboard/StaffDashboard.tsx src/components/dashboard/DashboardShell.tsx
git commit -m "feat(dashboard): DashboardShell compõe tudo (persona provider + brief + grid + footer + atalhos + telemetria)"
```

---

# Phase 8 · Migração e cleanup

### Task 34: Substituir `StaffHome` em `Index.tsx`

**Files:**
- Modify: `src/pages/Index.tsx`

- [ ] **Step 1:** Substituir conteúdo

Substituir TODO o arquivo `src/pages/Index.tsx` por:

```tsx
import { useAuth } from '@/contexts/AuthContext';
import { useUserRole } from '@/hooks/useUserRole';
import { Skeleton } from '@/components/ui/skeleton';

import { CustomerDashboard } from '@/components/CustomerDashboard';
import { StaffDashboard } from '@/components/dashboard/StaffDashboard';

import { useBasicProfile } from '@/queries/useProfile';
import { useCustomerPendingOrders } from '@/queries/useOrders';
import { useUserToolsSummary } from '@/queries/useUserTools';

const Index = () => {
  const { user } = useAuth();
  const { isStaff, loading: roleLoading } = useUserRole();

  const { data: profile, isLoading: profileLoading } = useBasicProfile(user?.id);
  const { data: pendingOrders = [], isLoading: customerOrdersLoading } =
    useCustomerPendingOrders(!isStaff ? user?.id : undefined);
  const { data: userTools = [] } =
    useUserToolsSummary(!isStaff ? user?.id : undefined, !isStaff && !roleLoading);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Bom dia';
    if (hour < 18) return 'Boa tarde';
    return 'Boa noite';
  };

  if (roleLoading || profileLoading || (!isStaff && customerOrdersLoading)) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
    );
  }

  if (!isStaff) {
    return (
      <CustomerDashboard
        profile={profile}
        pendingOrders={pendingOrders}
        userTools={userTools}
        getGreeting={getGreeting}
      />
    );
  }

  return <StaffDashboard />;
};

export default Index;
```

- [ ] **Step 2:** Validar dev (rota raiz `/`)

Run: `bun dev`
Acessar `http://localhost:8080/`.
Logar como staff. Deveria ver o novo dashboard (mesmo conteúdo de `/dashboard-v3`).
Logar como customer. Deveria ver o `CustomerDashboard` igual antes.

- [ ] **Step 3:** Commit

```bash
git add src/pages/Index.tsx
git commit -m "feat(dashboard): Index.tsx usa <StaffDashboard /> no lugar do StaffHome inline (full replace)"
```

---

### Task 35: Remover rota dev `/dashboard-v3` e import direto

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1:** Remover a rota e o import

Em `src/App.tsx`:
- Remover o import `import { StaffDashboard } from '@/components/dashboard/StaffDashboard';`
- Remover a linha `<Route path="dashboard-v3" element={<StaffDashboard />} />`

- [ ] **Step 2:** Validar

Run: `bun dev`
Acessar `http://localhost:8080/dashboard-v3`. Expected: 404 / route não encontrada (ou rota fallback do app).
Acessar `http://localhost:8080/`. Expected: dashboard novo continua funcionando.

- [ ] **Step 3:** Commit

```bash
git add src/App.tsx
git commit -m "chore(dashboard): remove rota dev /dashboard-v3 (full replace concluído em /)"
```

---

### Task 36: Validação final (lint, build, smoke completo)

- [ ] **Step 1:** Lint

Run: `bun lint`
Expected: zero erros. Warnings tolerados.

- [ ] **Step 2:** Build

Run: `bun build`
Expected: build passa sem erro. PWA é gerado.

- [ ] **Step 3:** Smoke test multi-persona

Run: `bun dev`

Verificações manuais em `http://localhost:8080/`:

1. **Como master** (usuário atual):
   - Chip "Visão" mostra "Master · via cargo comercial" (ou "padrão" se sem commercial_role)
   - 6 cards renderizam
   - Trocar switcher pra "Todas as empresas" → grid não quebra
   - Clicar persona chip → popover lista 8 personas → trocar pra "Financeiro" → ordem dos cards muda (Financeiro 1º)
   - Pressionar `?` → dialog de atalhos mostra grupo "Dashboard" com `g d`, `r`
   - Pressionar `r` → console mostra refetch

2. **DeltasStrip**:
   - Primeiro acesso (após `localStorage.clear()` do `dashboardLastVisit`) → mostra "Bem-vindo"
   - Voltar pra dashboard depois de visitar outras rotas e esperar 30+ min → mostra deltas (ou "Sem mudanças")

3. **PostHog** (se `VITE_POSTHOG_KEY` configurado):
   - Network mostra requests pra `posthog.com/e/` com eventos `dashboard.*`

- [ ] **Step 4:** Verificar git log

```bash
git log --oneline main..HEAD
```

Expected: lista de commits feature(dashboard-v3) + chore + docs. Histórico limpo.

- [ ] **Step 5:** Commit de conclusão (opcional, se houver tweaks)

Se algum ajuste for necessário após smoke, fazer commit separado. Caso contrário, prosseguir pra abertura de PR.

```bash
git status --short
```

Expected: clean.

---

## Critérios de "feito"

- [ ] `bun lint` zero erros
- [ ] `bun build` passa
- [ ] `bun test` todos os testes (incluindo os novos: persona-detect, persona-config, route-tracker, delta-aggregators, useDashboardCompany) passam
- [ ] Smoke test multi-persona OK (Master + Financeiro + Vendedor cada um vê ordem diferente)
- [ ] `mode=all` funciona em pelo menos Vendas + Financeiro
- [ ] DeltasStrip honra os 3 edge cases (primeiro acesso, <30min, empty)
- [ ] Atalhos `?`, `g d`, `r`, `1`..`6` funcionam
- [ ] Rota dev `/dashboard-v3` removida
- [ ] PostHog mostra eventos `dashboard.*` no Live Events
