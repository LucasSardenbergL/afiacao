# Controle de Acesso por Persona — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Controle de acesso determinístico por persona — filtra o menu lateral e bloqueia rotas (guard) conforme `commercial_role` + `department` + `app_role`, com default = vendedor.

**Architecture:** Camada `src/lib/access/` (resolver determinístico + matriz estática, libs puras testáveis), hook `useAccess()` que compõe os hooks de fonte existentes, componente `<RequireAccess>` pra guard de rota, e integração no `AppShell` (filtro de menu) + `App.tsx` (guards). Separada do `inferPersona` (dashboard).

**Tech Stack:** React 18 + TS + Vite, `@tanstack/react-query`, react-router-dom 6, vitest. Spec: `docs/superpowers/specs/2026-05-23-controle-acesso-persona-design.md`.

> **Convenção:** `bun run test` (vitest). Libs puras em `src/lib/access/__tests__/` ou `*.test.ts`. Branch: `claude/controle-acesso-persona`.

---

## File Structure

**Criar:**
- `src/lib/access/types.ts` — `AccessPersona`, `SectionId`, `GroupTag`.
- `src/lib/access/resolve-access.ts` (+ `.test.ts`) — `resolveAccessPersona`, `resolveGroupTag`.
- `src/lib/access/access-matrix.ts` (+ `.test.ts`) — `ACCESS`, `canAccess`, `isReadOnly`.
- `src/hooks/useAccess.ts` — compõe os hooks de fonte → `{ persona, group, loading, can, isReadOnly }`.
- `src/components/access/RequireAccess.tsx` — guard de rota.

**Modificar:**
- `src/hooks/useCommercialRole.ts` — estender o enum `CommercialRole` (falta farmer/hunter/closer/master).
- `src/components/AppShell.tsx` — cada item ganha `section`; filtro via `useAccess().can`.
- `src/App.tsx` — envolver grupos de rota com `<RequireAccess section=...>`.
- `src/pages/Customer360.tsx` — gate da seção financeira do cliente.

---

## Task 1: Estender o enum `CommercialRole`

**Files:**
- Modify: `src/hooks/useCommercialRole.ts:5`

- [ ] **Step 1: Atualizar o tipo pra refletir o enum real do banco**

O tipo atual é `export type CommercialRole = 'operacional' | 'gerencial' | 'estrategico' | 'super_admin';`. O banco tem mais valores (adicionados em migration). Trocar por:
```ts
export type CommercialRole =
  | 'operacional' | 'gerencial' | 'estrategico' | 'super_admin'
  | 'farmer' | 'hunter' | 'closer' | 'master';
```

- [ ] **Step 2: Build não regride**

Run: `bunx tsc --noEmit 2>&1 | grep -cE "error TS"`
Expected: mesmo número de antes (0 novos). O `inferPersona` usa um `switch` sobre `commercialRole` sem `default` exaustivo — confirmar que ainda compila (os novos valores caem na heurística, comportamento ok).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useCommercialRole.ts
git commit -m "feat(access): estende enum CommercialRole (farmer/hunter/closer/master)"
```

---

## Task 2: Tipos de acesso

**Files:**
- Create: `src/lib/access/types.ts`

- [ ] **Step 1: Escrever os tipos**

```ts
// src/lib/access/types.ts
export type AccessPersona =
  | 'vendedor' | 'gestor_comercial' | 'operacao' | 'financeiro' | 'gestao' | 'cliente';

export type GroupTag = 'hunter' | 'farmer' | 'closer';

export type SectionId =
  | 'principal'      // Dashboard + Meu dia
  | 'clientes'       // Customer 360
  | 'vendas'         // Pedidos / Novo / Ferramentas de venda / Telefonia / Chamadas
  | 'operacao'       // Recebimento / Picking / Tintométrico balcão / Produção
  | 'reposicao'
  | 'performance'
  | 'inteligencia'
  | 'financeiro'             // módulo /financeiro
  | 'tintometrico_cockpit'   // cockpit analítico de tintométrico
  | 'gestao_admin'           // Liberar Acessos / Departamentos / Governança / etc.
  | 'docs';                  // Ajuda / Design System / UX Rules
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/access/types.ts
git commit -m "feat(access): tipos AccessPersona/SectionId/GroupTag"
```

---

## Task 3: Resolver determinístico (TDD)

**Files:**
- Create: `src/lib/access/resolve-access.test.ts`
- Create: `src/lib/access/resolve-access.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/access/resolve-access.test.ts
import { describe, it, expect } from 'vitest';
import { resolveAccessPersona, resolveGroupTag } from './resolve-access';

const base = { appRole: null, commercialRole: null, department: null, isSalesOnly: false } as const;

describe('resolveAccessPersona', () => {
  it('master (app_role) → gestao', () => {
    expect(resolveAccessPersona({ ...base, appRole: 'master' })).toBe('gestao');
  });
  it('estrategico/super_admin → gestao', () => {
    expect(resolveAccessPersona({ ...base, commercialRole: 'estrategico' })).toBe('gestao');
    expect(resolveAccessPersona({ ...base, commercialRole: 'super_admin' })).toBe('gestao');
  });
  it('gerencial → gestor_comercial', () => {
    expect(resolveAccessPersona({ ...base, commercialRole: 'gerencial' })).toBe('gestor_comercial');
  });
  it('department gestao → gestor_comercial', () => {
    expect(resolveAccessPersona({ ...base, appRole: 'employee', department: 'gestao' })).toBe('gestor_comercial');
  });
  it('department financeiro → financeiro', () => {
    expect(resolveAccessPersona({ ...base, appRole: 'employee', department: 'financeiro' })).toBe('financeiro');
  });
  it('department separador/conferente/tintometrico → operacao', () => {
    for (const d of ['separador', 'conferente', 'tintometrico'] as const) {
      expect(resolveAccessPersona({ ...base, appRole: 'employee', department: d })).toBe('operacao');
    }
  });
  it('customer → cliente', () => {
    expect(resolveAccessPersona({ ...base, appRole: 'customer' })).toBe('cliente');
  });
  it('vendas (operacional/farmer/hunter/closer) → vendedor', () => {
    for (const r of ['operacional', 'farmer', 'hunter', 'closer'] as const) {
      expect(resolveAccessPersona({ ...base, appRole: 'employee', commercialRole: r })).toBe('vendedor');
    }
  });
  it('sales-only → vendedor', () => {
    expect(resolveAccessPersona({ ...base, appRole: 'employee', isSalesOnly: true })).toBe('vendedor');
  });
  it('staff sem tag → vendedor (default)', () => {
    expect(resolveAccessPersona({ ...base, appRole: 'employee' })).toBe('vendedor');
  });
});

describe('resolveGroupTag', () => {
  it('hunter/farmer/closer → o próprio', () => {
    expect(resolveGroupTag('hunter')).toBe('hunter');
    expect(resolveGroupTag('farmer')).toBe('farmer');
    expect(resolveGroupTag('closer')).toBe('closer');
  });
  it('demais → null', () => {
    expect(resolveGroupTag('operacional')).toBeNull();
    expect(resolveGroupTag(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar pra ver falhar**

Run: `bun run test src/lib/access/resolve-access.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

```ts
// src/lib/access/resolve-access.ts
import type { AppRole } from '@/contexts/AuthContext';
import type { CommercialRole } from '@/hooks/useCommercialRole';
import type { Department } from '@/integrations/supabase/types-departments';
import type { AccessPersona, GroupTag } from './types';

export interface AccessSignals {
  appRole: AppRole | null;
  commercialRole: CommercialRole | null;
  department: Department | null;
  isSalesOnly: boolean;
}

/** Resolve a persona de acesso de forma DETERMINÍSTICA (sem heurística). */
export function resolveAccessPersona(s: AccessSignals): AccessPersona {
  if (s.appRole === 'master'
    || s.commercialRole === 'estrategico'
    || s.commercialRole === 'super_admin'
    || s.commercialRole === 'master') return 'gestao';
  if (s.commercialRole === 'gerencial' || s.department === 'gestao') return 'gestor_comercial';
  if (s.department === 'financeiro') return 'financeiro';
  if (s.department === 'separador' || s.department === 'conferente' || s.department === 'tintometrico') return 'operacao';
  if (s.appRole === 'customer') return 'cliente';
  // operacional/farmer/hunter/closer, dept vendas, sales-only, ou staff sem tag → vendedor (default)
  return 'vendedor';
}

/** Tag de grupo comercial (não muda acesso; usada pela Performance e pela home). */
export function resolveGroupTag(commercialRole: CommercialRole | null): GroupTag | null {
  if (commercialRole === 'hunter' || commercialRole === 'farmer' || commercialRole === 'closer') {
    return commercialRole;
  }
  return null;
}
```

- [ ] **Step 4: Rodar pra ver passar**

Run: `bun run test src/lib/access/resolve-access.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/access/resolve-access.ts src/lib/access/resolve-access.test.ts
git commit -m "feat(access): resolveAccessPersona + resolveGroupTag (TDD)"
```

---

## Task 4: Matriz de acesso (TDD)

**Files:**
- Create: `src/lib/access/access-matrix.test.ts`
- Create: `src/lib/access/access-matrix.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/access/access-matrix.test.ts
import { describe, it, expect } from 'vitest';
import { canAccess, isReadOnly } from './access-matrix';

describe('canAccess', () => {
  it('vendedor: vendas/clientes/performance sim; financeiro/operacao/reposicao não', () => {
    expect(canAccess('vendedor', 'vendas')).toBe(true);
    expect(canAccess('vendedor', 'clientes')).toBe(true);
    expect(canAccess('vendedor', 'performance')).toBe(true);
    expect(canAccess('vendedor', 'financeiro')).toBe(false);
    expect(canAccess('vendedor', 'operacao')).toBe(false);
    expect(canAccess('vendedor', 'reposicao')).toBe(false);
  });
  it('gestor_comercial: inteligencia sim; financeiro/operacao não', () => {
    expect(canAccess('gestor_comercial', 'inteligencia')).toBe(true);
    expect(canAccess('gestor_comercial', 'clientes')).toBe(true);
    expect(canAccess('gestor_comercial', 'financeiro')).toBe(false);
    expect(canAccess('gestor_comercial', 'operacao')).toBe(false);
  });
  it('operacao: operacao sim; vendas/clientes não', () => {
    expect(canAccess('operacao', 'operacao')).toBe(true);
    expect(canAccess('operacao', 'vendas')).toBe(false);
    expect(canAccess('operacao', 'clientes')).toBe(false);
  });
  it('financeiro: financeiro/clientes sim; vendas leitura', () => {
    expect(canAccess('financeiro', 'financeiro')).toBe(true);
    expect(canAccess('financeiro', 'clientes')).toBe(true);
    expect(canAccess('financeiro', 'vendas')).toBe(true);
    expect(isReadOnly('financeiro', 'vendas')).toBe(true);
  });
  it('gestao: acessa tudo', () => {
    for (const s of ['principal','clientes','vendas','operacao','reposicao','performance','inteligencia','financeiro','tintometrico_cockpit','gestao_admin','docs'] as const) {
      expect(canAccess('gestao', s)).toBe(true);
    }
  });
  it('docs liberado pra todas as personas staff', () => {
    for (const p of ['vendedor','gestor_comercial','operacao','financeiro','gestao'] as const) {
      expect(canAccess(p, 'docs')).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Rodar pra ver falhar**

Run: `bun run test src/lib/access/access-matrix.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

```ts
// src/lib/access/access-matrix.ts
import type { AccessPersona, SectionId } from './types';

const ALL: SectionId[] = [
  'principal', 'clientes', 'vendas', 'operacao', 'reposicao', 'performance',
  'inteligencia', 'financeiro', 'tintometrico_cockpit', 'gestao_admin', 'docs',
];

export const ACCESS: Record<AccessPersona, { sections: SectionId[]; readOnly: SectionId[] }> = {
  gestao:           { sections: ALL, readOnly: [] },
  gestor_comercial: { sections: ['principal', 'clientes', 'vendas', 'performance', 'inteligencia', 'docs'], readOnly: [] },
  vendedor:         { sections: ['principal', 'clientes', 'vendas', 'performance', 'docs'], readOnly: [] },
  operacao:         { sections: ['principal', 'operacao', 'docs'], readOnly: [] },
  financeiro:       { sections: ['principal', 'clientes', 'vendas', 'financeiro', 'docs'], readOnly: ['vendas'] },
  cliente:          { sections: [], readOnly: [] }, // customer usa o portal próprio (nav de customer, fora desta matriz)
};

export function canAccess(persona: AccessPersona, section: SectionId): boolean {
  return ACCESS[persona].sections.includes(section);
}

export function isReadOnly(persona: AccessPersona, section: SectionId): boolean {
  return ACCESS[persona].readOnly.includes(section);
}
```

- [ ] **Step 4: Rodar pra ver passar**

Run: `bun run test src/lib/access/access-matrix.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/access/access-matrix.ts src/lib/access/access-matrix.test.ts
git commit -m "feat(access): matriz de acesso estática (canAccess/isReadOnly)"
```

---

## Task 5: Hook `useAccess`

**Files:**
- Create: `src/hooks/useAccess.ts`

Compõe os hooks de fonte. `useAuth()` expõe `role` (AppRole|null), `isStaff`, `loading`. `useCommercialRole()` → `{ commercialRole, loading }`. `useUserDepartment()` → `{ department }` (react-query). `useSalesOnlyRestriction()` → boolean.

- [ ] **Step 1: Implementar**

```ts
// src/hooks/useAccess.ts
import { useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useCommercialRole } from '@/hooks/useCommercialRole';
import { useUserDepartment } from '@/hooks/useUserDepartment';
import { useSalesOnlyRestriction } from '@/hooks/useSalesOnlyRestriction';
import { resolveAccessPersona, resolveGroupTag } from '@/lib/access/resolve-access';
import { canAccess, isReadOnly } from '@/lib/access/access-matrix';
import type { AccessPersona, GroupTag, SectionId } from '@/lib/access/types';

export interface UseAccessReturn {
  persona: AccessPersona;
  group: GroupTag | null;
  loading: boolean;
  can: (section: SectionId) => boolean;
  isReadOnly: (section: SectionId) => boolean;
}

export function useAccess(): UseAccessReturn {
  const { role, loading: authLoading } = useAuth();
  const { commercialRole, loading: crLoading } = useCommercialRole();
  const { department } = useUserDepartment();
  const isSalesOnly = useSalesOnlyRestriction();

  const persona = useMemo(
    () => resolveAccessPersona({ appRole: role, commercialRole, department, isSalesOnly }),
    [role, commercialRole, department, isSalesOnly],
  );
  const group = useMemo(() => resolveGroupTag(commercialRole), [commercialRole]);

  return {
    persona,
    group,
    loading: authLoading || crLoading,
    can: (section) => canAccess(persona, section),
    isReadOnly: (section) => isReadOnly(persona, section),
  };
}
```

> **Confira ao implementar:** os nomes reais de campos em `useAuth()` (`role`/`loading`) e `useCommercialRole()` (`commercialRole`/`loading`). Ajuste se diferirem. `useSalesOnlyRestriction()` retorna `boolean` direto.

- [ ] **Step 2: Lint + build**

Run: `bunx eslint src/hooks/useAccess.ts && bun run build 2>&1 | tail -3`
Expected: 0 erros, build ok.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useAccess.ts
git commit -m "feat(access): hook useAccess (compõe fontes → persona/group/can)"
```

---

## Task 6: Componente `RequireAccess` (TDD)

**Files:**
- Create: `src/components/access/__tests__/RequireAccess.test.tsx`
- Create: `src/components/access/RequireAccess.tsx`

- [ ] **Step 1: Escrever o teste que falha**

```tsx
// src/components/access/__tests__/RequireAccess.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RequireAccess } from '../RequireAccess';

const mockAccess = vi.fn();
vi.mock('@/hooks/useAccess', () => ({ useAccess: () => mockAccess() }));
vi.mock('react-router-dom', () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="redirect" data-to={to} />,
  Outlet: () => <div data-testid="outlet" />,
}));

describe('RequireAccess', () => {
  beforeEach(() => mockAccess.mockReset());

  it('loading → não redireciona nem mostra conteúdo (placeholder null)', () => {
    mockAccess.mockReturnValue({ loading: true, can: () => false });
    const { container } = render(<RequireAccess section="financeiro"><div data-testid="kid" /></RequireAccess>);
    expect(screen.queryByTestId('redirect')).toBeNull();
    expect(screen.queryByTestId('kid')).toBeNull();
    expect(container).toBeTruthy();
  });

  it('sem acesso → redireciona pra /', () => {
    mockAccess.mockReturnValue({ loading: false, can: () => false });
    render(<RequireAccess section="financeiro"><div data-testid="kid" /></RequireAccess>);
    expect(screen.getByTestId('redirect').getAttribute('data-to')).toBe('/');
  });

  it('com acesso → renderiza os filhos', () => {
    mockAccess.mockReturnValue({ loading: false, can: (s: string) => s === 'financeiro' });
    render(<RequireAccess section="financeiro"><div data-testid="kid" /></RequireAccess>);
    expect(screen.getByTestId('kid')).toBeInTheDocument();
  });

  it('sem children → renderiza <Outlet/> quando tem acesso', () => {
    mockAccess.mockReturnValue({ loading: false, can: () => true });
    render(<RequireAccess section="vendas" />);
    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Rodar pra ver falhar**

Run: `bun run test src/components/access/__tests__/RequireAccess.test.tsx`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

```tsx
// src/components/access/RequireAccess.tsx
import type { ReactNode } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAccess } from '@/hooks/useAccess';
import type { SectionId } from '@/lib/access/types';

interface Props {
  section: SectionId;
  children?: ReactNode;
  /** Pra onde redirecionar quando sem acesso. Default '/'. */
  redirectTo?: string;
}

/**
 * Guard de rota por seção de acesso. Bloqueia URL digitada na mão (não só esconde menu).
 * Enquanto carrega o acesso, não decide (evita flash de redirect). Use como wrapper de
 * grupo de rotas (com <Outlet/>) ou de uma rota única (com children).
 */
export function RequireAccess({ section, children, redirectTo = '/' }: Props) {
  const { loading, can } = useAccess();
  if (loading) return null;
  if (!can(section)) return <Navigate to={redirectTo} replace />;
  return <>{children ?? <Outlet />}</>;
}
```

- [ ] **Step 4: Rodar pra ver passar**

Run: `bun run test src/components/access/__tests__/RequireAccess.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/access/RequireAccess.tsx src/components/access/__tests__/RequireAccess.test.tsx
git commit -m "feat(access): RequireAccess (guard de rota por seção) — TDD"
```

---

## Task 7: Filtro de menu no `AppShell`

**Files:**
- Modify: `src/components/AppShell.tsx`

- [ ] **Step 1: Mapear cada item de nav pra uma `SectionId`**

READ `src/components/AppShell.tsx` (arrays `unifiedNavSections` + `docNavSection`, ~linhas 55-160). Adicionar um campo `section: SectionId` a CADA item de nav, conforme a seção dona dele:
- Principal (Dashboard, Meu dia) → `'principal'`; Clientes → `'clientes'`.
- Afiação (Ferramentas, Gamificação) → `'principal'` (são base; ou criar nada — ficam com vendedor+). Use `'principal'`.
- Vendas (Pedidos/Novo/Ferramentas de Venda/Telefonia/Chamadas) → `'vendas'`.
- Estoque (Recebimento) + Produção (Ordens) + tintométrico balcão → `'operacao'`.
- Reposição (Cockpit/Mercado/Parâmetros/Cadastros) → `'reposicao'`.
- Performance → `'performance'`.
- Inteligência (Dashboard Intel/AI Ops) → `'inteligencia'`.
- Financeiro (Cockpit CFO/Gestão/Análise) → `'financeiro'`.
- Tintométrico (Dashboard/Catálogo/Integração) → `'tintometrico_cockpit'`.
- Automação (Notificações/Portal Sayerlack) + Gestão (Liberar Acessos/Departamentos/KB/Calculadora/Processos/Governança) → `'gestao_admin'`.
- Documentação (Ajuda/Design System/UX Rules) → `'docs'`.

- [ ] **Step 2: Trocar o gating binário pelo `useAccess`**

No `AppSidebar`, adicionar `const { can } = useAccess();` (import `useAccess`). Onde hoje as seções/itens são filtradas por `managerOnly` + `isSalesOnly`, passar a filtrar por `can(item.section)`. Cada seção só aparece se tiver ≥1 item visível. Manter o `useSalesOnlyRestriction` SOMENTE como entrada do resolver (já é) — remover o uso direto dele pra esconder itens (o resolver+matriz já cobrem: sales-only→vendedor→só vê vendas/clientes/principal/performance/docs). Remover o flag `managerOnly` dos itens (substituído por `section`).

> **Nota:** itens base de CLIENTE (quando `role === 'customer'`) continuam pelo caminho atual de customer-nav — a matriz é pra staff. Se o AppShell já separa customer vs staff nav, não mexer no ramo customer.

- [ ] **Step 3: Build + lint + suíte**

Run: `bun run build 2>&1 | tail -3 && bunx eslint src/components/AppShell.tsx && bun run test 2>&1 | grep -E "Tests "`
Expected: build ok, lint 0, testes verdes (flaky reposicao ignorar).

- [ ] **Step 4: Commit**

```bash
git add src/components/AppShell.tsx
git commit -m "feat(access): menu lateral filtra por useAccess().can (substitui managerOnly/isSalesOnly)"
```

---

## Task 8: Guards de rota no `App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Envolver os grupos de rota com `<RequireAccess>`**

READ `src/App.tsx` (bloco `<Route element={<ProtectedRoute><AppShellLayout/></ProtectedRoute>}>`). Agrupar as rotas por seção e envolver cada grupo com um layout-route `<RequireAccess section=...>`. Padrão react-router v6 (rota-layout sem path, com `<Outlet/>` via RequireAccess):
```tsx
<Route element={<RequireAccess section="financeiro" />}>
  <Route path="financeiro/cockpit" element={<FinanceiroCockpit />} />
  <Route path="financeiro/gestao" element={<FinanceiroGestao />} />
  <Route path="financeiro/analise" element={<FinanceiroAnalise />} />
</Route>
```
Aplicar pros grupos sensíveis: `financeiro` (rotas /financeiro/*), `operacao` (/admin/estoque/*, /recebimento, /producao), `reposicao` (/admin/reposicao/*), `tintometrico_cockpit` (/tintometrico/*), `inteligencia` (/intelligence, /ai-ops), `gestao_admin` (/admin/approvals, /admin/departments, /gestao/*, /admin/notificacoes, /admin/portal-sayerlack), `vendas` (/sales/*, /telefonia, /vendas/*), `clientes` (/admin/customers + /admin/customers/:id). Rotas base (Dashboard /, /meu-dia, /tools, /profile, docs) ficam SEM guard (todos staff têm `principal`/`docs`).

> Não precisa cobrir 100% das 119 rotas — priorizar os grupos da matriz. Rotas não envolvidas seguem acessíveis (degradação segura), e o MENU já as esconde. O guard é pra bloquear URL direta dos módulos sensíveis.

- [ ] **Step 2: Build (valida rotas/JSX)**

Run: `bun run build 2>&1 | tail -3`
Expected: build ok.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(access): guards de rota <RequireAccess> nos módulos sensíveis"
```

---

## Task 9: Gate da seção financeira no Customer 360

**Files:**
- Modify: `src/pages/Customer360.tsx`

- [ ] **Step 1: Localizar a seção financeira do cliente**

READ `src/pages/Customer360.tsx` e achar a seção/aba que mostra a situação financeira do cliente (aging/crédito/limite — buscar por termos como `financ`, `aging`, `credito`, `limite`, `inadimpl`). Se não houver uma seção financeira dedicada hoje, **registrar como DONE_WITH_CONCERNS** (não há o que gatear ainda) e pular — o gate entra quando a seção existir.

- [ ] **Step 2: Gatear a renderização**

Adicionar `const { persona } = useAccess();` (import) e envolver a seção financeira do cliente com:
```tsx
{(['vendedor','gestor_comercial','financeiro','gestao'] as const).includes(persona) && (
  /* ...seção financeira do cliente... */
)}
```
(Quem acessa Customer 360 já é uma dessas personas; o gate é defensivo pra não vazar se o acesso a `clientes` for ampliado.)

- [ ] **Step 3: Build + commit**

Run: `bun run build 2>&1 | tail -3`
```bash
git add src/pages/Customer360.tsx
git commit -m "feat(access): gate da seção financeira do cliente no Customer 360"
```

---

## Task 10: Validação final + PR

- [ ] **Step 1: Suíte + build + lint**

Run: `bun run test && bun run build && bunx eslint src/lib/access src/hooks/useAccess.ts src/components/access`
Expected: testes verdes (inclui resolve-access + access-matrix + RequireAccess), build ok, lint 0.

- [ ] **Step 2: typecheck:strict (CI roda isso — não regredir)**

Run: `bun run typecheck:strict 2>&1 | grep -cE "error TS"`
Expected: 0.

- [ ] **Step 3: Abrir PR**

```bash
gh pr create --title "feat(access): controle de acesso por persona (matriz + resolver + menu + guards)" --body "Implementa o spec docs/superpowers/specs/2026-05-23-controle-acesso-persona-design.md. Sem migration (frontend-only). Default=vendedor."
```

---

## Self-review / observações
- **Sem migration** — é frontend-only; nenhum passo manual no Lovable.
- **Default seguro:** staff sem tag → vendedor (vê só vendas/clientes/principal/performance/docs). Pra dar acesso a operação/financeiro/gestão, taggear `commercial_role`/`department` via "Liberar Acessos"/"Departamentos".
- **Fora deste plano:** home por grupo (Sub-projeto B), filtro de dados da Performance por grupo (a tag fica pronta no `useAccess().group`), RLS de banco.
