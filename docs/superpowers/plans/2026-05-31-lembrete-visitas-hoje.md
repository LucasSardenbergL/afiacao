# Lembrete "Visitas de hoje" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Card "Visitas de hoje" no dashboard do vendedor (FarmerDashboardV2) mostrando as visitas pendentes agendadas por ele para hoje (count + até 3 nomes + CTA "Ver rota"), self-hide quando vazio.

**Architecture:** Helper puro `montarVisitasHoje` (TDD) → hook `useVisitasHoje` (query `visitas_agendadas` de hoje + enriquece nomes via `profiles`) → componente `VisitasHojeCard` (self-hide) → inserção no `FarmerDashboardV2`. Read-only, sem backend. `hojeISO()` (UTC) por consistência com o route planner.

**Tech Stack:** React, @tanstack/react-query, Supabase JS, react-router-dom, shadcn/ui, vitest.

**Spec:** `docs/superpowers/specs/2026-05-31-lembrete-visitas-hoje-design.md`

---

## File Structure
- **Create:** `src/lib/visitas/visitas-hoje.ts` + teste `src/lib/visitas/__tests__/visitas-hoje.test.ts` — helper puro `montarVisitasHoje`.
- **Create:** `src/hooks/useVisitasHoje.ts` — hook (query hoje + nomes).
- **Create:** `src/components/dashboard/VisitasHojeCard.tsx` — o card.
- **Modify:** `src/components/dashboard/FarmerDashboardV2.tsx` — inserir o card após `<KpisToday />`.

---

## Task 1: Helper puro `montarVisitasHoje` (TDD)

**Files:**
- Create: `src/lib/visitas/visitas-hoje.ts`
- Test: `src/lib/visitas/__tests__/visitas-hoje.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/visitas/__tests__/visitas-hoje.test.ts
import { describe, it, expect } from 'vitest';
import { montarVisitasHoje } from '../visitas-hoje';

const rows = [
  { id: 'v1', customer_user_id: 'u1' },
  { id: 'v2', customer_user_id: 'u2' },
  { id: 'v3', customer_user_id: 'u3' },
  { id: 'v4', customer_user_id: 'u4' },
];
const nomes = new Map([['u1', 'ACME'], ['u2', 'Beta'], ['u3', 'Gama']]);

describe('montarVisitasHoje', () => {
  it('total = todas as linhas; preview limitado a 3 por padrão', () => {
    const r = montarVisitasHoje(rows, nomes);
    expect(r.total).toBe(4);
    expect(r.preview).toHaveLength(3);
    expect(r.preview.map(p => p.nome)).toEqual(['ACME', 'Beta', 'Gama']);
  });

  it('resolve nome pelo Map e cai pra "Cliente" quando ausente', () => {
    const r = montarVisitasHoje([{ id: 'v4', customer_user_id: 'u4' }], nomes);
    expect(r.preview[0]).toEqual({ id: 'v4', customer_user_id: 'u4', nome: 'Cliente' });
  });

  it('lista vazia → total 0, preview vazio', () => {
    expect(montarVisitasHoje([], nomes)).toEqual({ total: 0, preview: [] });
  });

  it('respeita limit custom', () => {
    expect(montarVisitasHoje(rows, nomes, 2).preview).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/lembrete-visitas && heavy bun run test -- visitas-hoje`
Expected: FAIL — `Cannot find module '../visitas-hoje'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/visitas/visitas-hoje.ts
export interface VisitaHojeRow {
  id: string;
  customer_user_id: string;
}

export interface VisitaHojePreview {
  id: string;
  customer_user_id: string;
  nome: string;
}

export interface VisitasHojeResumo {
  total: number;
  preview: VisitaHojePreview[];
}

/**
 * Resumo do card "Visitas de hoje": total = todas as linhas (já filtradas por hoje),
 * preview = até `limit` enriquecidas com nome (fallback 'Cliente', espelha loadTodayVisits).
 * Puro, sem I/O.
 */
export function montarVisitasHoje(
  rows: VisitaHojeRow[],
  nomePorUsuario: Map<string, string>,
  limit = 3,
): VisitasHojeResumo {
  const preview = rows.slice(0, limit).map((r) => ({
    id: r.id,
    customer_user_id: r.customer_user_id,
    nome: nomePorUsuario.get(r.customer_user_id) || 'Cliente',
  }));
  return { total: rows.length, preview };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/lembrete-visitas && heavy bun run test -- visitas-hoje`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/visitas/visitas-hoje.ts src/lib/visitas/__tests__/visitas-hoje.test.ts
git commit -m "feat(visitas-hoje): helper puro montarVisitasHoje (TDD)"
```

---

## Task 2: Hook `useVisitasHoje`

**Files:**
- Create: `src/hooks/useVisitasHoje.ts`

Referência de padrão: `src/hooks/useVisitasAgendadas.ts` (useQuery + useAuth + supabase + visitasAgendadasTable). Aqui usamos `supabase.from('visitas_agendadas')` direto (a tabela já está tipada em `types.ts`).

- [ ] **Step 1: Escrever o hook**

```ts
// src/hooks/useVisitasHoje.ts
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { hojeISO } from '@/lib/visitas/today';
import { montarVisitasHoje, type VisitasHojeResumo } from '@/lib/visitas/visitas-hoje';

/**
 * Visitas de `visitas_agendadas` pendentes, agendadas pelo usuário logado, para HOJE.
 * "Hoje" = hojeISO() (UTC), consistente com loadScheduledVisits do route planner.
 * Enriquece com o nome do cliente (profiles). Read-only.
 */
export function useVisitasHoje(): { resumo: VisitasHojeResumo; isLoading: boolean } {
  const { user } = useAuth();
  const uid = user?.id;

  const query = useQuery({
    queryKey: ['visitas-hoje', uid],
    enabled: !!uid,
    queryFn: async (): Promise<VisitasHojeResumo> => {
      const { data: rows, error } = await supabase
        .from('visitas_agendadas')
        .select('id, customer_user_id')
        .eq('scheduled_by', uid!)
        .eq('status', 'pendente')
        .eq('scheduled_date', hojeISO())
        .order('scheduled_date', { ascending: true });
      if (error) throw new Error(error.message);

      const lista = rows ?? [];
      if (lista.length === 0) return { total: 0, preview: [] };

      const ids = [...new Set(lista.map((r) => r.customer_user_id))];
      const { data: profs } = await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', ids);
      const nameMap = new Map((profs ?? []).map((p) => [p.user_id, p.name]));

      return montarVisitasHoje(lista, nameMap);
    },
  });

  return { resumo: query.data ?? { total: 0, preview: [] }, isLoading: query.isLoading };
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/lembrete-visitas && heavy bun run typecheck`
Expected: exit 0. (Confirma que o `.select('id, customer_user_id')` tipa contra `visitas_agendadas` e que as linhas batem com `VisitaHojeRow`.)

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useVisitasHoje.ts
git commit -m "feat(visitas-hoje): hook useVisitasHoje (query hoje + nomes)"
```

---

## Task 3: Componente `VisitasHojeCard`

**Files:**
- Create: `src/components/dashboard/VisitasHojeCard.tsx`

- [ ] **Step 1: Escrever o card**

```tsx
// src/components/dashboard/VisitasHojeCard.tsx
import { Link } from 'react-router-dom';
import { CalendarCheck } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { track } from '@/lib/analytics';
import { useVisitasHoje } from '@/hooks/useVisitasHoje';

/**
 * Card "Visitas de hoje" — compromissos FIRMES (visitas_agendadas) que o vendedor
 * agendou para hoje. Distinto do AgendaTodayList (sugestões de ligação priorizadas).
 * Self-hide quando não há visita hoje.
 */
export function VisitasHojeCard() {
  const { resumo, isLoading } = useVisitasHoje();

  if (isLoading || resumo.total === 0) return null;

  const restantes = resumo.total - resumo.preview.length;

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarCheck className="w-4 h-4 text-status-info" />
          <div>
            <h2 className="text-sm font-semibold leading-none">Visitas de hoje</h2>
            <p className="text-xs text-muted-foreground">agendadas por você</p>
          </div>
        </div>
        <Badge variant="secondary">{resumo.total}</Badge>
      </div>

      <ul className="text-sm space-y-0.5">
        {resumo.preview.map((v) => (
          <li key={v.id} className="truncate">{v.nome}</li>
        ))}
      </ul>
      {restantes > 0 && (
        <p className="text-xs text-muted-foreground">+{restantes} restante{restantes > 1 ? 's' : ''}</p>
      )}

      <Button asChild size="sm" variant="outline" className="w-full">
        <Link to="/admin/route-planner" onClick={() => track('visitas_hoje.ver_rota')}>
          Ver rota
        </Link>
      </Button>
    </Card>
  );
}
```

- [ ] **Step 2: Verificar typecheck + lint**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/lembrete-visitas && heavy bun run typecheck && heavy bun run lint`
Expected: typecheck 0; lint 0 errors. (Confirma os imports shadcn + `track` + tokens `text-status-info`.)

- [ ] **Step 3: Commit**

```bash
git add src/components/dashboard/VisitasHojeCard.tsx
git commit -m "feat(visitas-hoje): VisitasHojeCard (self-hide, count + nomes + Ver rota)"
```

---

## Task 4: Inserir no `FarmerDashboardV2`

**Files:**
- Modify: `src/components/dashboard/FarmerDashboardV2.tsx`

- [ ] **Step 1: Adicionar o import**

No topo de `src/components/dashboard/FarmerDashboardV2.tsx`, junto aos outros imports de `./`:

```tsx
import { VisitasHojeCard } from './VisitasHojeCard';
```

- [ ] **Step 2: Inserir o card após `<KpisToday />`**

Localizar o bloco (linhas ~24-25):

```tsx
      <KpisToday />

      <Card className="p-3 space-y-1">
```

Inserir `<VisitasHojeCard />` entre eles:

```tsx
      <KpisToday />

      <VisitasHojeCard />

      <Card className="p-3 space-y-1">
```

> Ordem: "Meu dia" → KpisToday → **Visitas de hoje (firmes)** → Agenda de hoje (sugestões). O card self-hide quando vazio.

- [ ] **Step 3: Verificar typecheck + lint**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/lembrete-visitas && heavy bun run typecheck && heavy bun run lint`
Expected: typecheck 0; lint 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/FarmerDashboardV2.tsx
git commit -m "feat(visitas-hoje): monta VisitasHojeCard no FarmerDashboardV2"
```

---

## Task 5: Validação final

**Files:** nenhum (só validação)

- [ ] **Step 1: Suíte completa**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/lembrete-visitas && heavy bun run typecheck && heavy bun run lint && heavy bun run test && heavy bun run build`
Expected: typecheck 0 · lint 0 errors · test todos passando (incl. os 4 novos do montarVisitasHoje) · build ✓.

- [ ] **Step 2: Confirmar escopo**

Run: `git diff --stat $(git merge-base HEAD origin/main)`
Expected: só os 4 arquivos de código (2 em `src/lib/visitas/`, `useVisitasHoje.ts`, `VisitasHojeCard.tsx`, `FarmerDashboardV2.tsx`) + os 2 docs (spec/plano). NÃO toca `useVisitasAgendadas`, `AgendarVisitaDialog`, `useRoutePlanner`, RLS, backend.

---

## Self-Review (autor do plano)

**Spec coverage:**
- §4.1 helper `montarVisitasHoje` → Task 1 ✓
- §4.2 hook `useVisitasHoje` (query hoje UTC + nomes + helper) → Task 2 ✓
- §4.3 card (self-hide, título+subtítulo desambiguante, count, até 3 nomes, +N, "Ver rota") → Task 3 ✓
- §4.4 inserção após KpisToday, antes do AgendaTodayList → Task 4 ✓
- §3 timezone (hojeISO UTC) → usado no hook (Task 2) ✓
- §5 testes (helper TDD; fiação → QA) → Task 1 + nota Task 5 ✓
- §6 fora de escopo (não toca agendar/rota/RLS) → confirmado Task 5 Step 2 ✓

**Placeholder scan:** nenhum TBD; todo passo com código real.

**Type consistency:** `montarVisitasHoje(rows, nameMap, limit?)` idêntico em Task 1 (def) e Task 2 (uso). `VisitaHojeRow {id, customer_user_id}` bate com `.select('id, customer_user_id')`. `VisitasHojeResumo {total, preview}` consumido no card (Task 3: `resumo.total`, `resumo.preview`). `useVisitasHoje()` retorna `{resumo, isLoading}` — consumido exatamente assim no card. `hojeISO` importado de `@/lib/visitas/today`.
