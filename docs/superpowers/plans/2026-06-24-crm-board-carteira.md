# Board da Carteira (CRM passo 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans, task-by-task. Steps usam checkbox (`- [ ]`).
> **Deploy:** só **Publish** do frontend (sem banco). Verificar com `lovable-deploy-verify` (bytes do bundle). NÃO há migration nesta entrega.

**Goal:** Uma tela `/farmer/carteira` com a fila de trabalho do vendedor em 3 colunas (risco / expansão / follow-up), cards acionáveis (ligar + abrir 360), reusando dados que já existem — sem tocar o banco.

**Architecture:** Front puro. `useFarmerScoring()` dá `agenda` (agrupável por `agendaType`) + `clientScores` (nome/phone/health/churn); `useCarteiraSla()` (#1040) dá o badge de SLA. Um helper PURO `montarColunasBoard` cruza as 3 fontes por `customer_user_id` e devolve as colunas; componentes só renderizam. Decisão e justificativa em `docs/superpowers/specs/2026-06-24-crm-board-carteira-design.md` (§Virada).

**Tech Stack:** React 18 + TS strict + react-router 6 (lazy) + @tanstack/react-query; vitest; tokens `text-status-*`; deploy Lovable (Publish).

**Escopo:** board + helpers + card + página + rota + link de entrada. **Fora:** drag-drop, mobile dedicado, concluir-agenda, qualquer view/migration, refatorar FarmerDashboard.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `src/lib/carteira/board.ts` | Helpers PUROS: `AGENDA_TIPOS`, `healthBadge`, tipos VM, `montarColunasBoard` | Create |
| `src/lib/carteira/board.test.ts` | vitest dos helpers (cruzamento, agrupamento, badge) | Create |
| `src/components/farmer/CardCarteira.tsx` | Card de um cliente: nome, saúde, churn, badge SLA, ligar + 360 | Create |
| `src/components/farmer/BoardCarteira.tsx` | 3 colunas + EmptyState por coluna | Create |
| `src/pages/CarteiraBoard.tsx` | Página: chama hooks + `montarColunasBoard` + render | Create |
| `src/App.tsx` | Registrar rota lazy `/farmer/carteira` (espelhar `/farmer/calls`) | Modify |
| `src/pages/FarmerDashboard.tsx:~92` | 1 botão de entrada "Board da carteira" (após `<SlaVencidoCard>`) | Modify |

---

## Pré-requisitos
- [ ] Branch `claude/crm-board-carteira` (já criado). `bun install` se `node_modules` ausente.
- [ ] Conferir `origin/main` (domínio farmer quente — PRs #1037/#1043/#1046).

---

## Task 1: Helpers puros do board (`board.ts`) — TDD

**Files:** Create `src/lib/carteira/board.ts`, `src/lib/carteira/board.test.ts`

- [ ] **Step 1: Teste que falha** — `src/lib/carteira/board.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { healthBadge, montarColunasBoard } from './board';

describe('carteira/board', () => {
  it('healthBadge usa tokens de status', () => {
    expect(healthBadge('critico').className).toContain('text-status-error');
    expect(healthBadge('saudavel').label).toBe('Saudável');
  });

  it('monta 3 colunas na ordem risco/expansao/follow_up (vazias)', () => {
    const cols = montarColunasBoard([], [], []);
    expect(cols.map((c) => c.tipo)).toEqual(['risco', 'expansao', 'follow_up']);
    expect(cols.every((c) => c.cards.length === 0)).toBe(true);
  });

  it('cruza agenda × scores × sla no card', () => {
    const agenda = [
      { customer_user_id: 'a', customer_name: 'Cliente A', priorityScore: 80, agendaType: 'risco' as const, healthClass: 'critico' },
      { customer_user_id: 'b', customer_name: 'Cliente B', priorityScore: 50, agendaType: 'expansao' as const, healthClass: 'saudavel' },
    ];
    const scores = [
      { customer_user_id: 'a', customer_name: 'Cliente A', customer_phone: '11999', healthClass: 'critico', churnRisk: 90, priorityScore: 80 },
      { customer_user_id: 'b', customer_name: 'Cliente B', customer_phone: null, healthClass: 'saudavel', churnRisk: 5, priorityScore: 50 },
    ] as never[];
    const sla = [{ customer_user_id: 'a', vencido: true, dias_sem_contato: 30 }] as never[];
    const cols = montarColunasBoard(agenda as never[], scores, sla);
    const risco = cols.find((c) => c.tipo === 'risco')!;
    expect(risco.cards).toHaveLength(1);
    expect(risco.cards[0]).toMatchObject({ nome: 'Cliente A', phone: '11999', churnRisk: 90, slaVencido: true, diasSemContato: 30 });
    const exp = cols.find((c) => c.tipo === 'expansao')!;
    expect(exp.cards[0]).toMatchObject({ nome: 'Cliente B', slaVencido: false, diasSemContato: null });
  });
});
```

- [ ] **Step 2: Ver falhar** — `heavy bun run test src/lib/carteira/board.test.ts` → FAIL (módulo não existe).

- [ ] **Step 3: Implementar** — `src/lib/carteira/board.ts`:
```ts
import type { AgendaItem, ClientScore } from '@/hooks/useFarmerScoring';
import type { CarteiraSlaRow, HealthClass } from '@/hooks/useCarteiraSla';

export type AgendaTipo = 'risco' | 'expansao' | 'follow_up';

export const AGENDA_TIPOS: { tipo: AgendaTipo; label: string; tom: string }[] = [
  { tipo: 'risco', label: 'Risco', tom: 'text-status-error' },
  { tipo: 'expansao', label: 'Expansão', tom: 'text-status-success' },
  { tipo: 'follow_up', label: 'Follow-up', tom: 'text-status-info' },
];

export function healthBadge(h: HealthClass): { label: string; className: string } {
  const map: Record<HealthClass, { label: string; className: string }> = {
    saudavel: { label: 'Saudável', className: 'text-status-success' },
    estavel: { label: 'Estável', className: 'text-status-info' },
    atencao: { label: 'Atenção', className: 'text-status-warning' },
    critico: { label: 'Crítico', className: 'text-status-error' },
  };
  return map[h] ?? { label: String(h), className: 'text-muted-foreground' };
}

export interface CardCarteiraVM {
  customer_user_id: string;
  nome: string;
  agendaType: AgendaTipo;
  healthClass: HealthClass;
  churnRisk: number | null;
  phone: string | null;
  slaVencido: boolean;
  diasSemContato: number | null;
  priorityScore: number;
}

export interface ColunaBoard {
  tipo: AgendaTipo;
  label: string;
  tom: string;
  cards: CardCarteiraVM[];
}

export function montarColunasBoard(
  agenda: AgendaItem[],
  clientScores: ClientScore[],
  slaRows: CarteiraSlaRow[],
): ColunaBoard[] {
  const scoreById = new Map(clientScores.map((c) => [c.customer_user_id, c]));
  const slaById = new Map(slaRows.map((r) => [r.customer_user_id, r]));

  const cards: CardCarteiraVM[] = agenda.map((a) => {
    const sc = scoreById.get(a.customer_user_id);
    const sla = slaById.get(a.customer_user_id);
    return {
      customer_user_id: a.customer_user_id,
      nome: a.customer_name,
      agendaType: a.agendaType,
      healthClass: sc?.healthClass ?? (a.healthClass as HealthClass),
      churnRisk: sc?.churnRisk ?? null,
      phone: sc?.customer_phone ?? null,
      slaVencido: sla?.vencido ?? false,
      diasSemContato: sla?.dias_sem_contato ?? null,
      priorityScore: a.priorityScore,
    };
  });

  return AGENDA_TIPOS.map(({ tipo, label, tom }) => ({
    tipo, label, tom,
    cards: cards.filter((c) => c.agendaType === tipo),
  }));
}
```

- [ ] **Step 4: Ver passar** — `heavy bun run test src/lib/carteira/board.test.ts` → PASS (3 testes).
- [ ] **Step 5: Commit** — `git add src/lib/carteira/board.ts src/lib/carteira/board.test.ts && git commit -m "feat(crm): helpers puros do board da carteira (montarColunasBoard) + testes"`

---

## Task 2: Componentes `CardCarteira` + `BoardCarteira`

**Files:** Create `src/components/farmer/CardCarteira.tsx`, `src/components/farmer/BoardCarteira.tsx`

- [ ] **Step 1: `CardCarteira.tsx`**
```tsx
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Eye } from 'lucide-react';
import { CallButton } from '@/components/call/CallButton';
import { healthBadge, type CardCarteiraVM } from '@/lib/carteira/board';

export function CardCarteira({ card }: { card: CardCarteiraVM }) {
  const navigate = useNavigate();
  const hb = healthBadge(card.healthClass);
  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium truncate">{card.nome}</span>
        <span className={`text-xs ${hb.className}`}>{hb.label}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {card.churnRisk != null && <span>Churn {Math.round(card.churnRisk)}%</span>}
        {card.slaVencido && (
          <Badge variant="outline" className="text-status-error border-status-error/30">
            SLA vencido{card.diasSemContato != null ? ` (${card.diasSemContato}d)` : ''}
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-2">
        {card.phone && <CallButton phone={card.phone} customerName={card.nome} variant="icon" />}
        <Button size="sm" variant="outline" onClick={() => navigate(`/admin/customers/${card.customer_user_id}/360`)}>
          <Eye className="w-3.5 h-3.5 mr-1" /> 360
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `BoardCarteira.tsx`**
```tsx
import { Users } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { CardCarteira } from './CardCarteira';
import type { ColunaBoard } from '@/lib/carteira/board';

export function BoardCarteira({ colunas }: { colunas: ColunaBoard[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {colunas.map((col) => (
        <section key={col.tipo} aria-label={col.label} className="space-y-2">
          <header className="flex items-center justify-between">
            <h2 className={`font-display text-base ${col.tom}`}>{col.label}</h2>
            <span className="text-sm text-muted-foreground">{col.cards.length}</span>
          </header>
          {col.cards.length === 0 ? (
            <EmptyState icon={Users} title="Nada aqui" description="Sem clientes nesta coluna." tone="operational" />
          ) : (
            <div className="space-y-2">
              {col.cards.map((card) => <CardCarteira key={card.customer_user_id} card={card} />)}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
```
> Confirmar a API real de `<EmptyState>` (props `icon/title/description/tone`) lendo `src/components/EmptyState.tsx` — ajustar se divergir. Confirmar que `CallButton` aceita `variant="icon"` (já verificado: `src/components/call/CallButton.tsx:3-10`).

- [ ] **Step 3: Verificar** — `heavy bun run typecheck` → PASS.
- [ ] **Step 4: Commit** — `git add src/components/farmer/CardCarteira.tsx src/components/farmer/BoardCarteira.tsx && git commit -m "feat(crm): CardCarteira + BoardCarteira (3 colunas, ligar + 360)"`

---

## Task 3: Página `CarteiraBoard` + rota + link de entrada

**Files:** Create `src/pages/CarteiraBoard.tsx`; Modify `src/App.tsx`, `src/pages/FarmerDashboard.tsx`

- [ ] **Step 1: `CarteiraBoard.tsx`**
```tsx
import { useMemo } from 'react';
import { useFarmerScoring } from '@/hooks/useFarmerScoring';
import { useCarteiraSla } from '@/hooks/useCarteiraSla';
import { montarColunasBoard } from '@/lib/carteira/board';
import { BoardCarteira } from '@/components/farmer/BoardCarteira';
import { PageSkeleton } from '@/components/ui/page-skeleton';

export default function CarteiraBoard() {
  const { agenda, clientScores, loading } = useFarmerScoring();
  const { data: slaRows, isLoading: slaLoading } = useCarteiraSla();
  const colunas = useMemo(
    () => montarColunasBoard(agenda, clientScores, slaRows ?? []),
    [agenda, clientScores, slaRows],
  );
  if (loading || slaLoading) return <PageSkeleton variant="cockpit" />;
  return (
    <div className="min-h-screen bg-background">
      <main className="px-4 py-4 space-y-4 max-w-6xl mx-auto">
        <h1 className="font-display text-xl">Board da carteira</h1>
        <BoardCarteira colunas={colunas} />
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Rota em `src/App.tsx`** — adicionar o lazy import junto aos outros e a `<Route>` **espelhando exatamente** a linha de `/farmer/calls` (mesmo wrapper de auth/Suspense):
```tsx
const CarteiraBoard = lazy(() => import('./pages/CarteiraBoard'));
// ...na lista de rotas, ao lado das /farmer/*:
<Route path="/farmer/carteira" element={/* MESMO wrapper de /farmer/calls */ <CarteiraBoard />} />
```
> Ler a linha real de `path="/farmer/calls"` em `src/App.tsx` e replicar o wrapper idêntico (Suspense/guard). Não inventar um wrapper novo.

- [ ] **Step 3: Link de entrada no `FarmerDashboard.tsx`** — adicionar, logo após o `<SlaVencidoCard .../>` (≈ linha 92), um botão discreto (NÃO mexer no grid de quick actions):
```tsx
<Button variant="outline" size="sm" className="w-full" onClick={() => navigate('/farmer/carteira')}>
  Abrir board da carteira
</Button>
```

- [ ] **Step 4: Verificar** — `heavy bun run typecheck && heavy bun run lint` → PASS. Smoke: abrir `/farmer/carteira` e ver 3 colunas com cards; abrir `/farmer` e ver o botão de entrada.
- [ ] **Step 5: Commit** — `git add src/pages/CarteiraBoard.tsx src/App.tsx src/pages/FarmerDashboard.tsx && git commit -m "feat(crm): rota /farmer/carteira (board) + link de entrada no FarmerDashboard"`

---

## Deploy
- [ ] **Publish** do frontend no editor do Lovable (sem migration nesta entrega). Verificar pelos bytes com `lovable-deploy-verify` (alvo: string única, ex.: `Board da carteira`).

## Self-Review (autor)
1. **Cobertura:** board 3 colunas ✓ (Task 2-3); cards com ligar+360 ✓ (Task 2); badge SLA ✓ (helper+card); link de entrada ✓ (Task 3). Concluir-agenda fora por design ✓.
2. **Placeholders:** dois pontos marcados como "ler a linha real e espelhar" (rota `/farmer/calls`, API do `EmptyState`) — são referências a padrões existentes concretos, não lógica omitida.
3. **Tipos:** `AgendaTipo` consistente em `AGENDA_TIPOS`, `CardCarteiraVM`, `montarColunasBoard` e nos componentes; `CardCarteiraVM` deriva de `AgendaItem`/`ClientScore`/`CarteiraSlaRow` reais (campos verificados nos hooks). `CallButton` props conferem.
4. **Risco:** sem banco/RLS; o único toque em arquivo quente (FarmerDashboard) é 1 botão isolado, fora do grid.

## Execution Handoff
Após salvar: **subagent-driven** (1 subagente por task + review spec→qualidade) — recomendado; ou **inline**. As 3 tasks são pequenas e o trabalho é só front (typecheck/lint/vitest verificam localmente; nada depende do founder até o Publish).
