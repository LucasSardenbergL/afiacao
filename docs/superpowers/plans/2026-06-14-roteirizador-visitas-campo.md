# Roteirizador "Visitas em campo" (hunter) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao hunter (master/gestor) uma tela própria e limpa — "Visitas em campo" — separada do "Planejamento da equipe", onde ele escolhe várias cidades, vê clientes da carteira + prospects do Radar no mesmo mapa, marca quem visitar e monta a rota do dia; sem refazer a tela da equipe.

**Architecture:** 100% frontend sobre as RPCs do Radar já em produção (`radar_contagem_por_municipio`, `radar_prospects_para_rota`, `radar_salvar_geocode`, `registrar_contato_radar`). Introduz um eixo de **contexto** (`'campo' | 'equipe'`) acima do eixo de **modo** existente (`'logistica' | 'comercial' | 'hibrido' | 'manual' | 'prospeccao'`). O contexto "campo" reusa internamente o `planningMode='prospeccao'` (toda a infra de prospects+carteira já construída nas frentes #812/#816), mas com UI enxuta + multi-cidade + curadoria de alvos. O contexto "equipe" renderiza a tela atual **idêntica**. Multi-cidade = N chamadas à RPC single (`radar_prospects_para_rota`, top-N por cidade) juntadas no client. **Sem migration, sem edge, sem PG17** — só `Publish` no Lovable ao final.

**Tech Stack:** React 18 + TS strict, Vitest (helpers puros co-located `*.test.ts`), Leaflet 1.9 + OpenStreetMap, React Query, Supabase RPC, sonner.

**Restrições não-negociáveis (founder):**
- **NÃO tocar `src/hooks/useFarmerScoring.ts`** (hook compartilhado, money-path). Ele continua sendo chamado incondicionalmente pelo `useRoutePlanner`; no contexto "campo" ele roda em background como hoje, mas **não aparece nem bloqueia** (limitação conhecida — extrair p/ só rodar no "equipe" é follow-up).
- **Equipe (vendedor/separador) não vê mudança nenhuma.** Sem acesso ao "campo" → não vê nem o switcher de contexto; a tela renderiza igual à de hoje.
- **OpenStreetMap mantido** (Google Maps pago fora).
- Responder ao founder em **pt-BR**; manter `docs/roadmap-sessao.md` vivo.

**Spec:** `docs/superpowers/specs/2026-06-14-roteirizador-visitas-campo-design.md`

---

## File Structure

**Novos:**
- `src/lib/route/field-targets.ts` (+ `.test.ts`) — helpers puros: `defaultContextForRole`, `nextModeForContext`, `dedupeStopsById`, `particionarAlvos`, `filtrarAlvos`, `toggleTarget`.
- `src/components/reposicao/routePlanner/RoutePlannerContextTabs.tsx` — as 2 abas de contexto (Campo / Equipe).
- `src/components/reposicao/routePlanner/CityMultiSelector.tsx` — seletor multi-cidade (chips removíveis). Substitui o `CitySelector.tsx` single.
- `src/components/reposicao/routePlanner/FieldTargetsSummary.tsx` — resumo "N alvos: X clientes · Y prospects" + filtro Todos/Clientes/Prospects + aviso de alvos demais.
- `src/components/reposicao/routePlanner/FieldTargetCard.tsx` — linha de alvo (universo) com botão "Adicionar à rota / Na rota ✓".

**Modificados:**
- `src/components/reposicao/routePlanner/types.ts` — `+PlanningContext`, `+TargetFilter`.
- `src/components/reposicao/routePlanner/PlanningModeSelector.tsx` — remove o botão "Prospecção" (vira o contexto Campo).
- `src/hooks/useRoutePlanner.ts` — `planningContext`, `selectedCities[]`, `selectedTargetIds`, `targetFilter`, loaders multi-cidade, `stopsParaRota`/`fieldTargets`.
- `src/pages/AdminRoutePlanner.tsx` — render condicional Campo/Equipe + mapa com destaque de selecionados + fitBounds estável.

**Removidos:**
- `src/components/reposicao/routePlanner/CitySelector.tsx` (substituído por `CityMultiSelector`, fase 2).

---

# FASE 1 (sub-PR 1) — Navegação 2-contextos

**Entrega:** master abre em "Visitas em campo" (= prospecção de hoje, 1 cidade, mas com a UI enxuta — sem cards de logística, period filter, "Calculando…"); gestor comercial abre em "Planejamento da equipe" com acesso às 2 abas; vendedor/separador não veem o switcher (tela atual idêntica). Funcional e testável.

### Task 1.1: Helper de contexto (TDD)

**Files:**
- Create: `src/lib/route/field-targets.ts`
- Test: `src/lib/route/field-targets.test.ts`

- [ ] **Step 1: Escrever o teste falhando**

Create `src/lib/route/field-targets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { defaultContextForRole, nextModeForContext } from './field-targets';

describe('defaultContextForRole', () => {
  it('master abre no contexto campo (caça)', () => {
    expect(defaultContextForRole(true)).toBe('campo');
  });
  it('não-master (gestor/staff) abre no contexto equipe', () => {
    expect(defaultContextForRole(false)).toBe('equipe');
  });
});

describe('nextModeForContext', () => {
  it('contexto campo força o modo prospecção', () => {
    expect(nextModeForContext('campo', 'hibrido')).toBe('prospeccao');
    expect(nextModeForContext('campo', 'manual')).toBe('prospeccao');
  });
  it('voltar pra equipe troca prospecção por híbrido (default operacional)', () => {
    expect(nextModeForContext('equipe', 'prospeccao')).toBe('hibrido');
  });
  it('voltar pra equipe preserva um modo de equipe já escolhido', () => {
    expect(nextModeForContext('equipe', 'logistica')).toBe('logistica');
    expect(nextModeForContext('equipe', 'comercial')).toBe('comercial');
    expect(nextModeForContext('equipe', 'hibrido')).toBe('hibrido');
    expect(nextModeForContext('equipe', 'manual')).toBe('manual');
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `bun run test src/lib/route/field-targets.test.ts`
Expected: FAIL com "Failed to resolve import './field-targets'" ou "defaultContextForRole is not a function".

- [ ] **Step 3: Implementar o helper**

Create `src/lib/route/field-targets.ts`:

```ts
// Helpers puros do contexto "Visitas em campo" (hunter) do Roteirizador.
// Eixo de CONTEXTO ('campo' | 'equipe') acima do eixo de MODO existente.
// O contexto "campo" reusa internamente planningMode='prospeccao'.
import type { PlanningContext, PlanningMode } from '@/components/reposicao/routePlanner/types';

/** Contexto inicial por papel: master entra na caça (campo); o resto, na equipe. */
export function defaultContextForRole(isMaster: boolean): PlanningContext {
  return isMaster ? 'campo' : 'equipe';
}

/**
 * Modo de planejamento resultante ao trocar de contexto.
 * - campo → sempre 'prospeccao' (a infra de prospects+carteira).
 * - equipe → se vinha de 'prospeccao', cai no 'hibrido' (default operacional);
 *   senão preserva o modo de equipe já escolhido.
 */
export function nextModeForContext(ctx: PlanningContext, currentMode: PlanningMode): PlanningMode {
  if (ctx === 'campo') return 'prospeccao';
  return currentMode === 'prospeccao' ? 'hibrido' : currentMode;
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `bun run test src/lib/route/field-targets.test.ts`
Expected: PASS (5 testes).

Nota: este step depende do `PlanningContext` que será adicionado em `types.ts` na Task 1.2. Se o typecheck do teste reclamar do import antes da 1.2, faça a 1.2 primeiro e volte. (As duas tasks formam o commit 1.)

- [ ] **Step 5: Commit (junto com a Task 1.2)** — ver fim da Task 1.2.

### Task 1.2: Tipos `PlanningContext` e `TargetFilter`

**Files:**
- Modify: `src/components/reposicao/routePlanner/types.ts:12`

- [ ] **Step 1: Adicionar os tipos**

Em `src/components/reposicao/routePlanner/types.ts`, logo após a linha `export type PlanningMode = ...` (linha 12), adicionar:

```ts
/** Contexto de uso da tela: "campo" (hunter) vs "equipe" (operacional). */
export type PlanningContext = 'campo' | 'equipe';
/** Filtro do universo de alvos no contexto campo. */
export type TargetFilter = 'todos' | 'clientes' | 'prospects';
```

- [ ] **Step 2: Verificar typecheck + rodar o teste da 1.1**

Run: `bun run typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/tc.log`
Expected: EXIT=0.

Run: `bun run test src/lib/route/field-targets.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/route/field-targets.ts src/lib/route/field-targets.test.ts src/components/reposicao/routePlanner/types.ts
git commit -m "feat(roteirizador): tipos de contexto campo/equipe + helper de transição (TDD)"
```

### Task 1.3: Componente `RoutePlannerContextTabs`

**Files:**
- Create: `src/components/reposicao/routePlanner/RoutePlannerContextTabs.tsx`

- [ ] **Step 1: Criar o componente**

Create `src/components/reposicao/routePlanner/RoutePlannerContextTabs.tsx`:

```tsx
// Abas de contexto do Roteirizador: "Visitas em campo" (hunter) × "Planejamento
// da equipe" (operacional). Só renderiza quando o usuário tem acesso ao campo
// (gestor/master); para o resto da equipe a tela não muda (o pai nem monta isto).
import { MapPin, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PlanningContext } from './types';

const TABS: { key: PlanningContext; label: string; icon: typeof MapPin; hint: string }[] = [
  { key: 'campo', label: 'Visitas em campo', icon: MapPin, hint: 'Caçar clientes e prospects por cidade' },
  { key: 'equipe', label: 'Planejamento da equipe', icon: Users, hint: 'Logística, comercial, híbrido, manual' },
];

export function RoutePlannerContextTabs({
  value,
  onChange,
}: {
  value: PlanningContext;
  onChange: (ctx: PlanningContext) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border bg-muted/40 p-1">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const active = value === tab.key;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            title={tab.hint}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="w-4 h-4" />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `bun run typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/tc.log`
Expected: EXIT=0.

- [ ] **Step 3: Commit**

```bash
git add src/components/reposicao/routePlanner/RoutePlannerContextTabs.tsx
git commit -m "feat(roteirizador): componente de abas de contexto (campo/equipe)"
```

### Task 1.4: Remover "Prospecção" do `PlanningModeSelector`

**Files:**
- Modify: `src/components/reposicao/routePlanner/PlanningModeSelector.tsx`

O modo Prospecção deixa de ser um botão na faixa de modos — ele agora é o contexto "Visitas em campo". O seletor de modos passa a ser exclusivo do contexto "equipe" (4 modos).

- [ ] **Step 1: Reescrever o componente**

Replace o conteúdo inteiro de `src/components/reposicao/routePlanner/PlanningModeSelector.tsx` por:

```tsx
// Seletor de modo do contexto "Planejamento da equipe" (logística/comercial/
// híbrido/manual). O modo "prospecção" saiu daqui — virou o contexto "Visitas em
// campo" (RoutePlannerContextTabs). Renderizado só no contexto equipe.
import type { ReactNode } from 'react';
import { Route, Truck, ShoppingBag, Layers, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PlanningMode } from './types';

export function PlanningModeSelector({
  value,
  onChange,
}: {
  value: PlanningMode;
  onChange: (mode: PlanningMode) => void;
}) {
  const baseModes: { key: PlanningMode; label: string; icon: ReactNode }[] = [
    { key: 'logistica', label: 'Logística', icon: <Truck className="w-3.5 h-3.5" /> },
    { key: 'comercial', label: 'Comercial', icon: <ShoppingBag className="w-3.5 h-3.5" /> },
    { key: 'hibrido', label: 'Híbrido', icon: <Layers className="w-3.5 h-3.5" /> },
    { key: 'manual', label: 'Manual', icon: <Users className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Route className="w-4 h-4 text-muted-foreground" />
      <span className="text-sm font-medium text-muted-foreground">Modo:</span>
      {baseModes.map((mode) => (
        <Button
          key={mode.key}
          variant={value === mode.key ? 'default' : 'outline'}
          size="sm"
          onClick={() => onChange(mode.key)}
          className="gap-1.5"
        >
          {mode.icon}
          {mode.label}
        </Button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verificar typecheck** (vai falhar na página até a Task 1.6 — esperado)

Run: `bun run typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"; grep -i "showProspeccao\|PlanningModeSelector" /tmp/tc.log | head`
Expected: pode acusar `AdminRoutePlanner.tsx` passando `showProspeccao` (removido) — será corrigido na Task 1.6. Anote e siga.

- [ ] **Step 3: Commit (junto com 1.5 e 1.6 — são um conjunto coeso)** — ver fim da Task 1.6.

### Task 1.5: `useRoutePlanner` — eixo de contexto

**Files:**
- Modify: `src/hooks/useRoutePlanner.ts`

- [ ] **Step 1: Importar tipos e o helper**

Em `src/hooks/useRoutePlanner.ts`, no bloco de imports de tipos (linha 14-23), adicionar `PlanningContext` à lista:

```ts
import type {
  StopType,
  PlanningMode,
  PlanningContext,
  FilterPeriod,
  ManualFilter,
  ManualCustomer,
  VisitStatus,
  RouteStop,
  CityOption,
} from '@/components/reposicao/routePlanner/types';
```

E adicionar (após o import de `prospect-stop`, linha 31):

```ts
import { defaultContextForRole, nextModeForContext } from '@/lib/route/field-targets';
```

- [ ] **Step 2: Trocar o estado de default-por-papel**

Substituir o bloco de estado do modo (linhas 63-67):

```ts
  const [planningMode, setPlanningMode] = useState<PlanningMode>('hibrido');
  // Gestor/master (que enxerga o modo Prospecção) abre direto nele — é o uso do
  // hunter (visitar prospects) e evita o "Calculando oportunidades comerciais..."
  // do Híbrido (scoring pesado) na largada. Setado 1× quando o auth confirma.
  const modoInicialDefinido = useRef(false);
```

por:

```ts
  const [planningMode, setPlanningMode] = useState<PlanningMode>('hibrido');
  const [planningContext, setPlanningContext] = useState<PlanningContext>('equipe');
  // Quem tem acesso ao contexto "campo" (a caça): master e gestor comercial.
  const temAcessoCampo = isMaster || isGestorComercial;
  // Define o contexto inicial 1× quando o auth confirma: master entra no campo,
  // o resto na equipe. Sem isso, master cairia no Híbrido (scoring pesado).
  const contextoInicialDefinido = useRef(false);
```

- [ ] **Step 3: Trocar o efeito de default + adicionar handler de troca de contexto**

Substituir o efeito atual (linhas 102-109):

```ts
  // O master (founder/hunter) abre direto na Prospecção. Gestores comerciais
  // mantêm o Híbrido (rota de visitas do dia) e trocam de modo num clique.
  useEffect(() => {
    if (!modoInicialDefinido.current && !authLoading && isMaster) {
      setPlanningMode('prospeccao');
      modoInicialDefinido.current = true;
    }
  }, [authLoading, isMaster]);
```

por:

```ts
  // Troca de contexto: ajusta o modo interno coerentemente (campo→prospeccao;
  // equipe→hibrido se vinha de prospeccao). Helper puro testado.
  const mudarContexto = useCallback((ctx: PlanningContext) => {
    setPlanningContext(ctx);
    setPlanningMode((prev) => nextModeForContext(ctx, prev));
  }, []);

  // Contexto inicial por papel, 1× quando o auth confirma. Só quem tem acesso ao
  // campo é redirecionado; o resto fica em 'equipe' (default do estado).
  useEffect(() => {
    if (!contextoInicialDefinido.current && !authLoading && temAcessoCampo) {
      const ctx = defaultContextForRole(isMaster);
      setPlanningContext(ctx);
      setPlanningMode((prev) => nextModeForContext(ctx, prev));
      contextoInicialDefinido.current = true;
    }
  }, [authLoading, temAcessoCampo, isMaster]);
```

- [ ] **Step 4: Expor contexto no return e renomear `showProspeccao`**

No objeto de return, substituir o bloco de prospecção (linhas 1183-1187):

```ts
    // prospeccao mode
    showProspeccao: isMaster || isGestorComercial,
    selectedCity,
    setSelectedCity,
    loadingProspects,
```

por:

```ts
    // contexto campo/equipe
    planningContext,
    setPlanningContext: mudarContexto,
    temAcessoCampo,
    selectedCity,
    setSelectedCity,
    loadingProspects,
```

- [ ] **Step 5: Verificar typecheck do hook**

Run: `bun run typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"; grep -i "useRoutePlanner\|field-targets" /tmp/tc.log | head`
Expected: o hook não deve acusar erro próprio (a página `AdminRoutePlanner.tsx` ainda vai acusar até a 1.6).

### Task 1.6: `AdminRoutePlanner` — render condicional Campo/Equipe

**Files:**
- Modify: `src/pages/AdminRoutePlanner.tsx`

O contexto "campo" mostra a tela enxuta (CitySelector single nesta fase + mapa + rota); o "equipe" mostra a tela atual idêntica (modos + cards + period + agendadas).

- [ ] **Step 1: Ajustar o destructuring do hook**

Em `src/pages/AdminRoutePlanner.tsx`, no destructuring de `useRoutePlanner()` (linhas 78-83), substituir:

```ts
    // prospeccao mode
    showProspeccao,
    selectedCity,
    setSelectedCity,
    loadingProspects,
```

por:

```ts
    // contexto campo/equipe
    planningContext,
    setPlanningContext,
    temAcessoCampo,
    selectedCity,
    setSelectedCity,
    loadingProspects,
```

- [ ] **Step 2: Importar o componente de abas**

Adicionar ao bloco de imports (após a linha 13, o import do `PlanningModeSelector`):

```ts
import { RoutePlannerContextTabs } from '@/components/reposicao/routePlanner/RoutePlannerContextTabs';
```

- [ ] **Step 3: Reescrever o bloco de controles (acima do mapa)**

Substituir o bloco de controles (linhas 166-202, do comentário `{/* Planning mode selector */}` até o fechamento de `<ScheduledVisitsPanel />`) por:

```tsx
        {/* Abas de contexto — só p/ quem tem acesso ao campo (gestor/master).
            Sem isso, a equipe vê só o conteúdo de "equipe", sem switcher. */}
        {temAcessoCampo && (
          <RoutePlannerContextTabs value={planningContext} onChange={setPlanningContext} />
        )}

        {planningContext === 'campo' ? (
          /* ---------- VISITAS EM CAMPO (hunter) — UI enxuta ---------- */
          <CitySelector value={selectedCity} onChange={setSelectedCity} />
        ) : (
          /* ---------- PLANEJAMENTO DA EQUIPE — tela atual idêntica ---------- */
          <>
            <PlanningModeSelector value={planningMode} onChange={setPlanningMode} />

            {planningMode === 'manual' && (
              <ManualModeCard
                selectedCount={selectedCustomerIds.size}
                estimatedHours={estimatedManualHours}
                filter={manualFilter}
                onFilterChange={setManualFilter}
                search={manualSearch}
                onSearchChange={setManualSearch}
                loading={loadingManual}
                customers={filteredManualCustomers}
                isSelected={(id) => selectedCustomerIds.has(id)}
                isCheckedIn={(id) => !!visitStatuses.get(id)?.isCheckedIn}
                timerLabel={(id) => formatTimer(visitTimers.get(id) ?? 0)}
                onToggle={toggleCustomerSelection}
                onCheckIn={handleCheckIn}
                onCheckout={openCheckoutDialog}
              />
            )}

            <PeriodFilter value={filterPeriod} onChange={setFilterPeriod} />
            <StatsStrip planningMode={planningMode} stopCounts={stopCounts} />
            <ScheduledVisitsPanel />
          </>
        )}
```

- [ ] **Step 4: Ajustar o título e os loading states da lista**

No bloco da "Rota Otimizada" (linhas 219-251), o card "Calculando oportunidades comerciais…" já é gated por `planningMode === 'comercial' || 'hibrido'` → no campo nunca aparece (correto, sem mudança). Trocar apenas o título para refletir o contexto. Substituir (linha 222):

```tsx
            Rota Otimizada
```

por:

```tsx
            {planningContext === 'campo' ? 'Rota de hoje' : 'Rota Otimizada'}
```

- [ ] **Step 5: typecheck + lint + test + build**

```bash
bun run typecheck > /tmp/tc.log 2>&1; echo "TC=$?"; tail -3 /tmp/tc.log
bun lint > /tmp/lint.log 2>&1; echo "LINT=$?"; grep -c error /tmp/lint.log
bun run test src/lib/route/ > /tmp/test.log 2>&1; echo "TEST=$?"; tail -3 /tmp/test.log
heavy bun run build > /tmp/build.log 2>&1; echo "BUILD=$?"; tail -3 /tmp/build.log
```
Expected: TC=0, LINT sem novos errors, TEST=0, BUILD=0.

- [ ] **Step 6: Commit**

```bash
git add src/components/reposicao/routePlanner/PlanningModeSelector.tsx src/hooks/useRoutePlanner.ts src/pages/AdminRoutePlanner.tsx
git commit -m "feat(roteirizador): contexto campo/equipe — master abre na caça, equipe intacta"
```

### Task 1.7: Abrir PR da Fase 1

- [ ] **Step 1: Push + PR (squash --auto)**

```bash
git push -u origin claude/roteirizador-visitas-campo
gh pr create --title "feat(roteirizador): Visitas em campo — navegação 2-contextos (sub-PR 1)" \
  --body "$(cat <<'EOF'
## Sub-PR 1/3 — Navegação 2-contextos

Separa **Visitas em campo** (hunter, gestor/master) de **Planejamento da equipe** (operacional). Spec: docs/superpowers/specs/2026-06-14-roteirizador-visitas-campo-design.md

- Master abre em "Visitas em campo" (= prospecção, UI enxuta — sem cards de logística/period/agendadas/"Calculando…").
- Gestor comercial abre em "Planejamento da equipe", com acesso às 2 abas.
- Vendedor/separador: **zero mudança** (não vê switcher; tela atual idêntica).
- Modo "Prospecção" saiu da faixa de modos → virou o contexto Campo.
- 100% frontend. **NÃO toca useFarmerScoring** (roda em background como hoje; no campo não aparece/bloqueia).

Próximos: sub-PR 2 (multi-cidade), sub-PR 3 (curadoria de alvos).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr merge --squash --auto
```

> ⚠️ Sem `--admin`. Esperar o CI `validate` passar. Sem migration/edge/Publish nesta fase (a feature só vai ao ar com Publish ao final da Fase 3, mas cada PR pode mergear isolado).

---

# FASE 2 (sub-PR 2) — Multi-cidade (100% frontend)

**Entrega:** o hunter escolhe várias cidades de uma vez (busca + checkbox + chips removíveis); o mapa e a lista mostram clientes da carteira + prospects do Radar de **todas** as cidades escolhidas. N chamadas à RPC single existente, juntadas e deduplicadas no client. Sem migration.

### Task 2.1: Helper `dedupeStopsById` (TDD)

**Files:**
- Modify: `src/lib/route/field-targets.ts`
- Modify: `src/lib/route/field-targets.test.ts`

- [ ] **Step 1: Adicionar o teste falhando**

Append em `src/lib/route/field-targets.test.ts`:

```ts
import { dedupeStopsById } from './field-targets';

describe('dedupeStopsById', () => {
  it('remove ids repetidos preservando a primeira ocorrência', () => {
    const out = dedupeStopsById([
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
      { id: 'a', n: 3 },
    ]);
    expect(out).toEqual([{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
  });
  it('lista vazia → vazia', () => {
    expect(dedupeStopsById([])).toEqual([]);
  });
  it('sem repetição → idêntica', () => {
    const input = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
    expect(dedupeStopsById(input)).toEqual(input);
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `bun run test src/lib/route/field-targets.test.ts`
Expected: FAIL com "dedupeStopsById is not a function".

- [ ] **Step 3: Implementar**

Append em `src/lib/route/field-targets.ts`:

```ts
/** Dedupe por `id`, preservando a primeira ocorrência (ordem estável). */
export function dedupeStopsById<T extends { id: string }>(stops: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of stops) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}
```

- [ ] **Step 4: Rodar e confirmar passa**

Run: `bun run test src/lib/route/field-targets.test.ts`
Expected: PASS (8 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/route/field-targets.ts src/lib/route/field-targets.test.ts
git commit -m "feat(roteirizador): helper dedupeStopsById (TDD)"
```

### Task 2.2: `CityMultiSelector` (novo) + remover `CitySelector`

**Files:**
- Create: `src/components/reposicao/routePlanner/CityMultiSelector.tsx`
- Delete: `src/components/reposicao/routePlanner/CitySelector.tsx` (na Task 2.4, após trocar o uso)

- [ ] **Step 1: Criar o `CityMultiSelector`**

Create `src/components/reposicao/routePlanner/CityMultiSelector.tsx`:

```tsx
// Seletor MULTI-cidade do contexto "Visitas em campo". Reusa a RPC
// radar_contagem_por_municipio (até 500 cidades, com nº de prospects por cidade).
// Selecionar NÃO fecha o popover (multi); cidades viram chips removíveis.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, MapPin, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import type { CityOption } from './types';

interface RawCidadeRow {
  municipio_codigo: string;
  municipio_nome: string;
  uf: string;
  lat: number | null;
  lng: number | null;
  total: number;
  com_telefone: number;
  a_contatar: number;
}

async function fetchCidades(): Promise<CityOption[]> {
  const { data, error } = await supabase.rpc(
    'radar_contagem_por_municipio',
    { p_limit: 500 } as never,
  );
  if (error) throw error;
  const rows = (data ?? []) as RawCidadeRow[];
  return rows.map((r) => ({
    codigo: r.municipio_codigo,
    nome: r.municipio_nome,
    uf: r.uf,
    total: r.total,
    comTelefone: r.com_telefone,
    aContatar: r.a_contatar,
  }));
}

interface CityMultiSelectorProps {
  value: CityOption[];
  onToggle: (city: CityOption) => void;
  onRemove: (codigo: string) => void;
}

export function CityMultiSelector({ value, onToggle, onRemove }: CityMultiSelectorProps) {
  const [open, setOpen] = useState(false);
  const selectedCodes = new Set(value.map((c) => c.codigo));

  const { data: cidades = [], isLoading } = useQuery({
    queryKey: ['radar-cidades-rota'],
    queryFn: fetchCidades,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <MapPin className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium text-muted-foreground shrink-0">Cidades:</span>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              className="min-w-[240px] justify-between font-normal"
              disabled={isLoading}
            >
              <span className="truncate">
                {isLoading
                  ? 'Carregando…'
                  : value.length === 0
                    ? 'Selecione as cidades…'
                    : `${value.length} cidade(s) selecionada(s)`}
              </span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[340px] p-0" align="start">
            <Command>
              <CommandInput placeholder="Buscar cidade…" />
              <CommandList>
                <CommandEmpty>Nenhuma cidade encontrada.</CommandEmpty>
                <CommandGroup>
                  {cidades.map((cidade) => {
                    const selected = selectedCodes.has(cidade.codigo);
                    return (
                      <CommandItem
                        key={cidade.codigo}
                        value={`${cidade.nome} ${cidade.uf}`}
                        onSelect={() => onToggle(cidade)}
                      >
                        <Check className={cn('mr-2 h-4 w-4', selected ? 'opacity-100' : 'opacity-0')} />
                        <span className="flex-1">
                          {cidade.nome} ({cidade.uf})
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                          {cidade.total} prospects
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((c) => (
            <Badge key={c.codigo} variant="secondary" className="gap-1 pr-1">
              {c.nome} ({c.uf})
              <button
                type="button"
                onClick={() => onRemove(c.codigo)}
                className="ml-0.5 rounded-sm hover:bg-muted-foreground/20"
                aria-label={`Remover ${c.nome}`}
              >
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `bun run typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/tc.log`
Expected: EXIT=0 (o componente novo compila; ainda não usado).

- [ ] **Step 3: Commit**

```bash
git add src/components/reposicao/routePlanner/CityMultiSelector.tsx
git commit -m "feat(roteirizador): seletor multi-cidade com chips removíveis"
```

### Task 2.3: `useRoutePlanner` — `selectedCities[]` + loaders multi-cidade

**Files:**
- Modify: `src/hooks/useRoutePlanner.ts`

- [ ] **Step 1: Importar o helper de dedupe e trocar o estado de cidade**

Em `src/hooks/useRoutePlanner.ts`, ajustar o import do helper (já importa `defaultContextForRole, nextModeForContext`; adicionar `dedupeStopsById`):

```ts
import { defaultContextForRole, nextModeForContext, dedupeStopsById } from '@/lib/route/field-targets';
```

Substituir o estado de prospecção (linhas 88-92):

```ts
  // Prospecção mode state
  const [selectedCity, setSelectedCity] = useState<CityOption | null>(null);
  const [prospectStops, setProspectStops] = useState<RouteStop[]>([]);
  const [carteiraCidadeStops, setCarteiraCidadeStops] = useState<RouteStop[]>([]);
  const [loadingProspects, setLoadingProspects] = useState(false);
```

por:

```ts
  // Contexto campo: cidades escolhidas (multi) + alvos carregados.
  const [selectedCities, setSelectedCities] = useState<CityOption[]>([]);
  const [prospectStops, setProspectStops] = useState<RouteStop[]>([]);
  const [carteiraCidadeStops, setCarteiraCidadeStops] = useState<RouteStop[]>([]);
  const [loadingProspects, setLoadingProspects] = useState(false);

  const toggleCity = useCallback((city: CityOption) => {
    setSelectedCities((prev) =>
      prev.some((c) => c.codigo === city.codigo)
        ? prev.filter((c) => c.codigo !== city.codigo)
        : [...prev, city],
    );
  }, []);

  const removeCity = useCallback((codigo: string) => {
    setSelectedCities((prev) => prev.filter((c) => c.codigo !== codigo));
  }, []);
```

- [ ] **Step 2: Reescrever `loadProspectStops` para multi-cidade**

Substituir `loadProspectStops` inteiro (linhas 717-760) por:

```ts
  // Prospects de N cidades: N chamadas à RPC single (top-50 por cidade),
  // juntadas e deduplicadas no client. 2-4 cidades = 2-4 round-trips (OK).
  const loadProspectStops = useCallback(async (cities: CityOption[]) => {
    if (cities.length === 0) { setProspectStops([]); return; }
    setLoadingProspects(true);
    try {
      const results = await Promise.all(
        cities.map((city) =>
          supabase.rpc(
            'radar_prospects_para_rota' as never,
            { p_municipio_codigo: city.codigo, p_limit: 50 } as never,
          ),
        ),
      );
      const rows: ProspectRow[] = [];
      for (const { data, error } of results) {
        if (error) throw error;
        rows.push(...((data ?? []) as unknown as ProspectRow[]));
      }
      const stops: RouteStop[] = rows.map((row) => {
        const draft = prospectRowToStopDraft(row);
        if (draft.lat != null && draft.lng != null && draft.geocodeFailed !== true) {
          geocodedCoords.current.set(draft.id, { lat: draft.lat, lng: draft.lng });
        }
        const base: Omit<RouteStop, 'priorityScore' | 'priorityLabel' | 'priorityFactors'> = {
          id: draft.id,
          customerUserId: '',  // intencional — bloqueia check-in (FK route_visits)
          customerName: draft.customerName,
          phone: draft.phone ?? null,
          address: draft.address,
          visitReason: draft.visitReason,
          stopType: 'prospect_visit',
          timeSlot: null,
          businessHoursOpen: null,
          businessHoursClose: null,
          status: 'prospect',
          lat: draft.lat ?? undefined,
          lng: draft.lng ?? undefined,
          radarCnpj: draft.radarCnpj,
          geocodeFailed: draft.geocodeFailed,
          prospeccaoStatus: draft.prospeccaoStatus,
        };
        return enrichWithPriority(base);
      });
      setProspectStops(dedupeStopsById(stops));
    } catch (err) {
      console.error('Error loading prospect stops:', err);
      toast.error('Erro ao carregar prospects');
      setProspectStops([]);
    } finally {
      setLoadingProspects(false);
    }
  }, []);
```

- [ ] **Step 3: Reescrever `loadCarteiraDaCidade` para multi-cidade**

Substituir `loadCarteiraDaCidade` inteiro (linhas 767-818) por:

```ts
  // Clientes da CARTEIRA nas cidades escolhidas (sales_visit, laranja). N queries
  // ilike (addresses.city é texto livre), juntadas e deduplicadas por user_id.
  const loadCarteiraDaCidade = useCallback(async (cities: CityOption[]) => {
    if (cities.length === 0) { setCarteiraCidadeStops([]); return; }
    try {
      const perCity = await Promise.all(
        cities.map(async (city) => {
          const { data: addrs, error } = await supabase
            .from('addresses')
            .select('user_id, street, number, neighborhood, city, state, zip_code, complement')
            .ilike('city', city.nome)
            .order('user_id', { ascending: true })  // determinístico: trunca o mesmo subconjunto
            .limit(100);
          if (error) throw error;
          return { cityNome: city.nome, addrs: addrs ?? [] };
        }),
      );
      // Dedup por user_id (primeira cidade que o trouxe vence) + guarda a cidade.
      const byUser = new Map<string, { addr: (typeof perCity)[number]['addrs'][number]; cityNome: string }>();
      for (const { cityNome, addrs } of perCity) {
        for (const a of addrs) {
          if (a.user_id && !byUser.has(a.user_id)) byUser.set(a.user_id, { addr: a, cityNome });
        }
      }
      const userIds = Array.from(byUser.keys());
      if (userIds.length === 0) { setCarteiraCidadeStops([]); return; }
      const { data: profiles, error: profErr } = await supabase
        .from('profiles')
        .select('user_id, name, phone, business_hours_open, business_hours_close')
        .in('user_id', userIds)
        .or('is_employee.is.null,is_employee.eq.false');
      if (profErr) throw profErr;
      const stops: RouteStop[] = (profiles ?? []).map((p) => {
        const { addr: a, cityNome } = byUser.get(p.user_id)!;
        const base: Omit<RouteStop, 'priorityScore' | 'priorityLabel' | 'priorityFactors'> = {
          id: `carteira-cidade-${p.user_id}`,
          customerUserId: p.user_id,
          customerName: p.name ?? 'Cliente',
          phone: p.phone ?? null,
          address: {
            street: a.street ?? '',
            number: a.number ?? '',
            neighborhood: a.neighborhood ?? '',
            city: a.city ?? '',
            state: a.state ?? '',
            zip_code: a.zip_code ?? '',
            complement: a.complement ?? undefined,
          },
          visitReason: `Cliente em ${cityNome}`,
          stopType: 'sales_visit',
          timeSlot: null,
          businessHoursOpen: p.business_hours_open ?? null,
          businessHoursClose: p.business_hours_close ?? null,
          status: 'carteira',
        };
        return enrichWithPriority(base);
      });
      setCarteiraCidadeStops(dedupeStopsById(stops));
    } catch (err) {
      console.error('Error loading carteira da cidade:', err);
      setCarteiraCidadeStops([]);
    }
  }, []);
```

- [ ] **Step 4: Atualizar o efeito de carga e o `allStops`**

Substituir o efeito de carga (linhas 822-830):

```ts
  useEffect(() => {
    if (planningMode === 'prospeccao' && selectedCity) {
      void loadProspectStops(selectedCity);
      void loadCarteiraDaCidade(selectedCity);
    } else if (planningMode !== 'prospeccao') {
      setProspectStops([]);
      setCarteiraCidadeStops([]);
    }
  }, [planningMode, selectedCity, loadProspectStops, loadCarteiraDaCidade]);
```

por:

```ts
  useEffect(() => {
    if (planningMode === 'prospeccao' && selectedCities.length > 0) {
      void loadProspectStops(selectedCities);
      void loadCarteiraDaCidade(selectedCities);
    } else {
      setProspectStops([]);
      setCarteiraCidadeStops([]);
    }
  }, [planningMode, selectedCities, loadProspectStops, loadCarteiraDaCidade]);
```

- [ ] **Step 5: Atualizar o return (trocar `selectedCity`/`setSelectedCity` por `selectedCities`/`toggleCity`/`removeCity`)**

No return, substituir o bloco (que após a Fase 1 está como `selectedCity, setSelectedCity, loadingProspects,` dentro de "contexto campo/equipe"):

```ts
    selectedCity,
    setSelectedCity,
    loadingProspects,
```

por:

```ts
    selectedCities,
    toggleCity,
    removeCity,
    loadingProspects,
```

- [ ] **Step 6: Verificar typecheck do hook (página vai acusar até a 2.4)**

Run: `bun run typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"; grep -i "selectedCit\|useRoutePlanner" /tmp/tc.log | head`
Expected: o hook compila; `AdminRoutePlanner.tsx` acusa `selectedCity` removido — corrigido na 2.4.

### Task 2.4: `AdminRoutePlanner` — usar `CityMultiSelector`

**Files:**
- Modify: `src/pages/AdminRoutePlanner.tsx`
- Delete: `src/components/reposicao/routePlanner/CitySelector.tsx`

- [ ] **Step 1: Trocar o import**

Substituir o import do `CitySelector` (linha 14):

```ts
import { CitySelector } from '@/components/reposicao/routePlanner/CitySelector';
```

por:

```ts
import { CityMultiSelector } from '@/components/reposicao/routePlanner/CityMultiSelector';
```

- [ ] **Step 2: Trocar o destructuring**

No destructuring do hook, substituir:

```ts
    selectedCity,
    setSelectedCity,
    loadingProspects,
```

por:

```ts
    selectedCities,
    toggleCity,
    removeCity,
    loadingProspects,
```

- [ ] **Step 3: Trocar o uso no contexto campo**

Substituir (do Step 3 da Task 1.6):

```tsx
        {planningContext === 'campo' ? (
          /* ---------- VISITAS EM CAMPO (hunter) — UI enxuta ---------- */
          <CitySelector value={selectedCity} onChange={setSelectedCity} />
        ) : (
```

por:

```tsx
        {planningContext === 'campo' ? (
          /* ---------- VISITAS EM CAMPO (hunter) — UI enxuta ---------- */
          <CityMultiSelector value={selectedCities} onToggle={toggleCity} onRemove={removeCity} />
        ) : (
```

- [ ] **Step 4: Atualizar o empty-state do campo (texto multi-cidade)**

No empty-state da lista (linha ~258), substituir:

```tsx
                  : planningMode === 'prospeccao' ? 'Selecione uma cidade acima para ver os prospects.'
```

por:

```tsx
                  : planningMode === 'prospeccao' ? 'Selecione uma ou mais cidades acima para ver os alvos (clientes + prospects).'
```

- [ ] **Step 5: Deletar o `CitySelector` órfão**

```bash
git rm src/components/reposicao/routePlanner/CitySelector.tsx
```

- [ ] **Step 6: typecheck + lint + test + build**

```bash
bun run typecheck > /tmp/tc.log 2>&1; echo "TC=$?"; tail -3 /tmp/tc.log
bun lint > /tmp/lint.log 2>&1; echo "LINT=$?"; grep -c error /tmp/lint.log
bun run test src/lib/route/ > /tmp/test.log 2>&1; echo "TEST=$?"; tail -3 /tmp/test.log
heavy bun run build > /tmp/build.log 2>&1; echo "BUILD=$?"; tail -3 /tmp/build.log
```
Expected: TC=0, LINT sem novos errors, TEST=0, BUILD=0.

> ⚠️ Confirmar que nada mais importa `CitySelector`:
> Run: `grep -rn "routePlanner/CitySelector" src/ | grep -v CityMultiSelector`
> Expected: vazio.

- [ ] **Step 7: Commit + PR**

```bash
git add -A
git commit -m "feat(roteirizador): multi-cidade no contexto campo (N cidades, alvos juntos)"
git push
gh pr create --title "feat(roteirizador): Visitas em campo — multi-cidade (sub-PR 2)" \
  --body "$(cat <<'EOF'
## Sub-PR 2/3 — Multi-cidade

Sobre a navegação do sub-PR 1: o hunter escolhe **várias cidades** (busca + checkbox + chips removíveis); o mapa e a lista mostram clientes da carteira + prospects do Radar de **todas** as cidades.

- N chamadas à RPC single `radar_prospects_para_rota` (top-50/cidade), juntadas + deduplicadas no client. **Sem migration** (reusa a RPC em prod).
- Carteira: N queries `ilike('city')` juntadas + dedup por user_id.
- `CitySelector` (single) substituído por `CityMultiSelector` e deletado.
- 100% frontend.

Próximo: sub-PR 3 (curadoria de alvos + rota só dos marcados + filtro).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr merge --squash --auto
```

---

# FASE 3 (sub-PR 3) — Seleção de alvos + rota curada + resumo/filtro

**Entrega:** o mapa/lista mostram o **universo de alvos** das cidades; o hunter **marca quem visitar** (botão na lista, destaque no mapa); a "Rota de hoje" contém **só os marcados**, otimizada. Resumo "N alvos: X clientes · Y prospects" + filtro Todos/Clientes/Prospects. Sem migration.

### Task 3.1: Helpers de curadoria (TDD)

**Files:**
- Modify: `src/lib/route/field-targets.ts`
- Modify: `src/lib/route/field-targets.test.ts`

- [ ] **Step 1: Adicionar os testes falhando**

Append em `src/lib/route/field-targets.test.ts`:

```ts
import { particionarAlvos, filtrarAlvos, toggleTarget } from './field-targets';
import type { RouteStop } from '@/components/reposicao/routePlanner/types';

const mk = (id: string, stopType: RouteStop['stopType']): RouteStop => ({
  id,
  stopType,
  customerUserId: stopType === 'prospect_visit' ? '' : `u-${id}`,
  customerName: id,
  phone: null,
  address: { street: '', number: '', neighborhood: '', city: '', state: '', zip_code: '' },
  timeSlot: null,
  businessHoursOpen: null,
  businessHoursClose: null,
  status: '',
  visitReason: '',
  priorityScore: 0,
  priorityLabel: 'baixa',
  priorityFactors: [],
});

describe('particionarAlvos', () => {
  it('separa prospects (prospect_visit) de clientes (resto)', () => {
    const stops = [mk('a', 'prospect_visit'), mk('b', 'sales_visit'), mk('c', 'prospect_visit')];
    const { clientes, prospects } = particionarAlvos(stops);
    expect(prospects.map((s) => s.id)).toEqual(['a', 'c']);
    expect(clientes.map((s) => s.id)).toEqual(['b']);
  });
});

describe('filtrarAlvos', () => {
  const stops = [mk('a', 'prospect_visit'), mk('b', 'sales_visit')];
  it('todos → tudo', () => {
    expect(filtrarAlvos(stops, 'todos')).toHaveLength(2);
  });
  it('clientes → só não-prospect', () => {
    expect(filtrarAlvos(stops, 'clientes').map((s) => s.id)).toEqual(['b']);
  });
  it('prospects → só prospect_visit', () => {
    expect(filtrarAlvos(stops, 'prospects').map((s) => s.id)).toEqual(['a']);
  });
});

describe('toggleTarget', () => {
  it('adiciona id ausente (novo Set)', () => {
    const a = new Set<string>(['x']);
    const b = toggleTarget(a, 'y');
    expect([...b].sort()).toEqual(['x', 'y']);
    expect(b).not.toBe(a);
  });
  it('remove id presente', () => {
    expect([...toggleTarget(new Set(['x', 'y']), 'x')]).toEqual(['y']);
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `bun run test src/lib/route/field-targets.test.ts`
Expected: FAIL com "particionarAlvos is not a function".

- [ ] **Step 3: Implementar**

Append em `src/lib/route/field-targets.ts`:

```ts
import type { RouteStop, TargetFilter } from '@/components/reposicao/routePlanner/types';

/** Separa o universo de alvos em prospects (prospect_visit) e clientes (resto). */
export function particionarAlvos(stops: RouteStop[]): { clientes: RouteStop[]; prospects: RouteStop[] } {
  const clientes: RouteStop[] = [];
  const prospects: RouteStop[] = [];
  for (const s of stops) {
    if (s.stopType === 'prospect_visit') prospects.push(s);
    else clientes.push(s);
  }
  return { clientes, prospects };
}

/** Filtra o universo de alvos por Todos/Clientes/Prospects. */
export function filtrarAlvos(stops: RouteStop[], filtro: TargetFilter): RouteStop[] {
  if (filtro === 'todos') return stops;
  if (filtro === 'prospects') return stops.filter((s) => s.stopType === 'prospect_visit');
  return stops.filter((s) => s.stopType !== 'prospect_visit');
}

/** Toggle imutável de um id no conjunto de alvos selecionados pra rota. */
export function toggleTarget(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
```

- [ ] **Step 4: Rodar e confirmar passa**

Run: `bun run test src/lib/route/field-targets.test.ts`
Expected: PASS (todos, ~14 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/route/field-targets.ts src/lib/route/field-targets.test.ts
git commit -m "feat(roteirizador): helpers de curadoria de alvos (particionar/filtrar/toggle, TDD)"
```

### Task 3.2: `FieldTargetsSummary` (resumo + filtro + aviso)

**Files:**
- Create: `src/components/reposicao/routePlanner/FieldTargetsSummary.tsx`

- [ ] **Step 1: Criar o componente**

Create `src/components/reposicao/routePlanner/FieldTargetsSummary.tsx`:

```tsx
// Resumo do universo de alvos do contexto campo + filtro Todos/Clientes/Prospects.
// Avisa quando há alvos demais (o mapa geocodifica no máx ~15 por vez — Nominatim).
import { Users, Target, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { TargetFilter } from './types';

const LIMITE_AVISO = 60;

export function FieldTargetsSummary({
  totalClientes,
  totalProspects,
  filtro,
  onFiltroChange,
}: {
  totalClientes: number;
  totalProspects: number;
  filtro: TargetFilter;
  onFiltroChange: (f: TargetFilter) => void;
}) {
  const total = totalClientes + totalProspects;
  const opcoes: { key: TargetFilter; label: string }[] = [
    { key: 'todos', label: 'Todos' },
    { key: 'clientes', label: 'Clientes' },
    { key: 'prospects', label: 'Prospects' },
  ];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-sm">
          <span className="font-semibold text-foreground">{total} alvos</span>
          <span className="flex items-center gap-1 text-orange-600">
            <Users className="w-3.5 h-3.5" /> {totalClientes} clientes
          </span>
          <span className="flex items-center gap-1 text-yellow-600">
            <Target className="w-3.5 h-3.5" /> {totalProspects} prospects
          </span>
        </div>
        <div className="flex gap-1">
          {opcoes.map((o) => (
            <Button
              key={o.key}
              size="sm"
              variant={filtro === o.key ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => onFiltroChange(o.key)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      </div>
      {total > LIMITE_AVISO && (
        <div className="flex items-center gap-2 rounded-md bg-status-warning-bg px-3 py-2 text-xs text-status-warning">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          Muitos alvos ({total}). O mapa mostra os primeiros geocodificados — refine as cidades ou use o filtro acima.
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: typecheck + commit**

```bash
bun run typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"; tail -3 /tmp/tc.log
git add src/components/reposicao/routePlanner/FieldTargetsSummary.tsx
git commit -m "feat(roteirizador): resumo de alvos + filtro Todos/Clientes/Prospects"
```

### Task 3.3: `FieldTargetCard` (linha de alvo do universo)

**Files:**
- Create: `src/components/reposicao/routePlanner/FieldTargetCard.tsx`

- [ ] **Step 1: Criar o componente**

Create `src/components/reposicao/routePlanner/FieldTargetCard.tsx`:

```tsx
// Linha de um alvo (cliente da carteira OU prospect do Radar) no universo de
// alvos do contexto campo. Botão "Adicionar à rota" / "Na rota ✓" (toggle).
import { Plus, Check, Phone } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { RouteStop } from './types';
import { STOP_CONFIG } from './constants';

export function FieldTargetCard({
  stop,
  naRota,
  onToggleRota,
}: {
  stop: RouteStop;
  naRota: boolean;
  onToggleRota: () => void;
}) {
  const cfg = STOP_CONFIG[stop.stopType];
  return (
    <Card className={naRota ? 'border-primary/50 bg-primary/5' : ''}>
      <CardContent className="py-2.5 px-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-medium text-foreground truncate text-sm">{stop.customerName}</p>
              <Badge className={`text-[10px] px-1.5 py-0 ${cfg.bgClass} border-0`}>{cfg.label}</Badge>
            </div>
            <p className="text-xs text-muted-foreground truncate">
              {stop.address.street}
              {stop.address.number ? `, ${stop.address.number}` : ''} — {stop.address.neighborhood || stop.address.city}
            </p>
          </div>
          {stop.phone && (
            <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" asChild>
              <a href={`tel:${stop.phone}`} aria-label="Ligar">
                <Phone className="w-3.5 h-3.5" />
              </a>
            </Button>
          )}
          <Button
            size="sm"
            variant={naRota ? 'default' : 'outline'}
            className="h-8 text-xs gap-1 shrink-0"
            onClick={onToggleRota}
          >
            {naRota ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            {naRota ? 'Na rota' : 'Adicionar'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: typecheck + commit**

```bash
bun run typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"; tail -3 /tmp/tc.log
git add src/components/reposicao/routePlanner/FieldTargetCard.tsx
git commit -m "feat(roteirizador): card de alvo do universo (adicionar/remover da rota)"
```

### Task 3.4: `useRoutePlanner` — seleção, filtro, universo vs rota

**Files:**
- Modify: `src/hooks/useRoutePlanner.ts`

- [ ] **Step 1: Importar os helpers de curadoria + tipos**

Ajustar o import do helper:

```ts
import {
  defaultContextForRole,
  nextModeForContext,
  dedupeStopsById,
  particionarAlvos,
  filtrarAlvos,
  toggleTarget,
} from '@/lib/route/field-targets';
```

Adicionar `TargetFilter` à lista de tipos importados de `types` (junto a `PlanningContext`):

```ts
  PlanningContext,
  TargetFilter,
```

- [ ] **Step 2: Adicionar estado de seleção e filtro**

Logo após o bloco de `toggleCity`/`removeCity` (Task 2.3 Step 1), adicionar:

```ts
  // Curadoria do contexto campo: alvos marcados pra rota + filtro do universo.
  const [selectedTargetIds, setSelectedTargetIds] = useState<Set<string>>(new Set());
  const [targetFilter, setTargetFilter] = useState<TargetFilter>('todos');

  const toggleTargetId = useCallback((id: string) => {
    setSelectedTargetIds((prev) => toggleTarget(prev, id));
  }, []);
```

- [ ] **Step 3: Limpar a seleção quando as cidades mudam**

Logo após o `useEffect` de carga (Task 2.3 Step 4), adicionar um efeito que zera a seleção ao trocar de cidades (os ids antigos não existem mais):

```ts
  // Trocar as cidades reinicia a curadoria (ids antigos não pertencem ao novo universo).
  useEffect(() => {
    setSelectedTargetIds(new Set());
  }, [selectedCities]);
```

- [ ] **Step 4: Derivar universo de alvos, filtro e rota curada**

Logo após o `geocodedAllStops` ser definido e o efeito de geocoding progressivo (após a linha ~974, depois do `return () => controller.abort();` do efeito de geocoding), adicionar:

```ts
  // ----- Contexto campo: universo de alvos vs rota curada -----
  // O universo é tudo que veio das cidades (prospects + carteira), já geocodificado
  // progressivamente. A rota contém SÓ os alvos marcados.
  const fieldTargets = useMemo(
    () => (planningContext === 'campo' ? geocodedAllStops : []),
    [planningContext, geocodedAllStops],
  );

  const filteredFieldTargets = useMemo(
    () => filtrarAlvos(fieldTargets, targetFilter),
    [fieldTargets, targetFilter],
  );

  const resumoAlvos = useMemo(() => {
    const { clientes, prospects } = particionarAlvos(fieldTargets);
    return { totalClientes: clientes.length, totalProspects: prospects.length };
  }, [fieldTargets]);

  // Paradas que entram na otimização: no campo, só os marcados; na equipe, como hoje.
  const stopsParaRota = useMemo(() => {
    if (planningContext === 'campo') {
      return geocodedAllStops.filter((s) => selectedTargetIds.has(s.id));
    }
    return filteredStops;
  }, [planningContext, geocodedAllStops, selectedTargetIds, filteredStops]);
```

- [ ] **Step 5: Apontar `optimizedRoute` para `stopsParaRota`**

No `useMemo` do `optimizedRoute` (linha ~983), trocar a base `filteredStops` por `stopsParaRota`. Substituir a linha de abertura:

```ts
  const optimizedRoute = useMemo(() => {
    if (filteredStops.length <= 1) return filteredStops;

    const withCoords = filteredStops.filter(s => s.lat && s.lng);
    const withoutCoords = filteredStops.filter(s => !s.lat || !s.lng)
```

por:

```ts
  const optimizedRoute = useMemo(() => {
    if (stopsParaRota.length <= 1) return stopsParaRota;

    const withCoords = stopsParaRota.filter(s => s.lat && s.lng);
    const withoutCoords = stopsParaRota.filter(s => !s.lat || !s.lng)
```

E na dependência do mesmo `useMemo` (linha ~1050), trocar `[filteredStops, filterPeriod]` por `[stopsParaRota, filterPeriod]`.

> Nota: `filteredStops` continua existindo (usado por `stopsParaRota` no ramo equipe). Só o `optimizedRoute` passa a ler de `stopsParaRota`.

- [ ] **Step 6: Expor no return**

No bloco "contexto campo/equipe" do return, adicionar (junto a `selectedCities`/`toggleCity`/`removeCity`):

```ts
    // curadoria de alvos (contexto campo)
    fieldTargets,
    filteredFieldTargets,
    resumoAlvos,
    selectedTargetIds,
    toggleTargetId,
    targetFilter,
    setTargetFilter,
```

- [ ] **Step 7: typecheck do hook**

Run: `bun run typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"; grep -i "useRoutePlanner\|stopsParaRota\|fieldTargets" /tmp/tc.log | head`
Expected: o hook compila; a página acusa props novos não-usados ainda — corrigido na 3.5.

### Task 3.5: `AdminRoutePlanner` — universo no mapa/lista + rota curada + fitBounds estável

**Files:**
- Modify: `src/pages/AdminRoutePlanner.tsx`

- [ ] **Step 1: Importar os componentes novos**

Adicionar aos imports:

```ts
import { FieldTargetsSummary } from '@/components/reposicao/routePlanner/FieldTargetsSummary';
import { FieldTargetCard } from '@/components/reposicao/routePlanner/FieldTargetCard';
```

- [ ] **Step 2: Destructuring dos novos campos**

No destructuring do hook, junto a `selectedCities, toggleCity, removeCity, loadingProspects`, adicionar:

```ts
    fieldTargets,
    filteredFieldTargets,
    resumoAlvos,
    selectedTargetIds,
    toggleTargetId,
    targetFilter,
    setTargetFilter,
```

- [ ] **Step 3: Renderizar o resumo no contexto campo**

No bloco do contexto campo (Task 2.4 Step 3), trocar:

```tsx
        {planningContext === 'campo' ? (
          /* ---------- VISITAS EM CAMPO (hunter) — UI enxuta ---------- */
          <CityMultiSelector value={selectedCities} onToggle={toggleCity} onRemove={removeCity} />
        ) : (
```

por:

```tsx
        {planningContext === 'campo' ? (
          /* ---------- VISITAS EM CAMPO (hunter) — UI enxuta ---------- */
          <>
            <CityMultiSelector value={selectedCities} onToggle={toggleCity} onRemove={removeCity} />
            {fieldTargets.length > 0 && (
              <FieldTargetsSummary
                totalClientes={resumoAlvos.totalClientes}
                totalProspects={resumoAlvos.totalProspects}
                filtro={targetFilter}
                onFiltroChange={setTargetFilter}
              />
            )}
          </>
        ) : (
```

- [ ] **Step 4: Reescrever o efeito de markers (destaque dos selecionados)**

Substituir o efeito "Update map markers" inteiro (linhas 99-144) por:

```tsx
  // Update map markers.
  // No contexto campo: mostra o UNIVERSO de alvos (filtrado); os marcados ganham
  // número (posição na rota) + azul; os não-marcados, a cor do tipo, sem número.
  // No contexto equipe: a rota otimizada numerada (como antes).
  useEffect(() => {
    if (!leafletMap.current || !markersRef.current) return;
    markersRef.current.clearLayers();
    routeLineRef.current?.remove();

    const fonte = planningContext === 'campo' ? filteredFieldTargets : optimizedRoute;
    const ordemRota = new Map(optimizedRoute.map((s, i) => [s.id, i + 1]));

    const fonteComCoords = fonte.filter((s) => s.lat && s.lng);
    if (fonteComCoords.length === 0) return;

    fonteComCoords.forEach((stop) => {
      const numero = ordemRota.get(stop.id);
      const cor = numero != null ? '#2563eb' : STOP_CONFIG[stop.stopType].markerColor;
      const conteudo = numero != null ? String(numero) : '';
      const icon = L.divIcon({
        className: 'custom-marker',
        html: `<div style="
          background: ${cor};
          color: white; width: 26px; height: 26px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-weight: 700; font-size: 12px; border: 2px solid white;
          box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        ">${conteudo}</div>`,
        iconSize: [26, 26], iconAnchor: [13, 13],
      });

      const hoursLabel = stop.businessHoursOpen && stop.businessHoursClose
        ? `${stop.businessHoursOpen} - ${stop.businessHoursClose}` : 'Não informado';
      const cfg = STOP_CONFIG[stop.stopType];

      L.marker([stop.lat!, stop.lng!], { icon })
        .bindPopup(`
          <strong>${numero != null ? `${numero}. ` : ''}${stop.customerName}</strong><br/>
          <span style="color: ${cfg.markerColor}; font-weight: 600">${cfg.label}</span><br/>
          ${stop.address.street}, ${stop.address.number}<br/>
          ${stop.address.neighborhood} - ${stop.address.city}<br/>
          <em>${stop.visitReason}</em><br/>
          <em>Horário: ${hoursLabel}</em>
        `)
        .addTo(markersRef.current!);
    });

    // Linha da rota: só os marcados/otimizados (em ambos os contextos).
    const coords: L.LatLngExpression[] = optimizedRoute
      .filter((s) => s.lat && s.lng)
      .map((s) => [s.lat!, s.lng!]);
    if (coords.length > 1) {
      routeLineRef.current = L.polyline(coords, {
        color: 'hsl(var(--primary))', weight: 3, opacity: 0.7, dashArray: '8, 8',
      }).addTo(leafletMap.current);
    }
  }, [optimizedRoute, filteredFieldTargets, planningContext]);

  // fitBounds SEPARADO: re-enquadra só quando o CONJUNTO de pinos muda (cidades/
  // filtro/geocode) — NÃO quando a seleção muda (senão o mapa "pula" enquanto o
  // hunter marca alvos). Guardado por uma chave de ids.
  const lastBoundsKey = useRef('');
  useEffect(() => {
    if (!leafletMap.current) return;
    const fonte = planningContext === 'campo' ? filteredFieldTargets : optimizedRoute;
    const withCoords = fonte.filter((s) => s.lat && s.lng);
    const key = withCoords.map((s) => s.id).join('|');
    if (key && key !== lastBoundsKey.current) {
      leafletMap.current.fitBounds(
        L.latLngBounds(withCoords.map((s) => [s.lat!, s.lng!] as L.LatLngExpression)),
        { padding: [40, 40] },
      );
      lastBoundsKey.current = key;
    }
  }, [planningContext, filteredFieldTargets, optimizedRoute]);
```

- [ ] **Step 5: Inserir a lista "Alvos na cidade" (universo) antes da rota, só no campo**

Logo após o `<Card>` do mapa + `<RouteActionButtons>` (linha ~216), e ANTES do bloco `<div className="space-y-2">` da "Rota Otimizada", inserir:

```tsx
        {/* Universo de alvos (contexto campo): marque quem visitar */}
        {planningContext === 'campo' && filteredFieldTargets.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-foreground">
              Alvos nas cidades
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                marque quem visitar hoje
              </span>
            </h2>
            <div className="space-y-1.5">
              {filteredFieldTargets.map((stop) => (
                <FieldTargetCard
                  key={stop.id}
                  stop={stop}
                  naRota={selectedTargetIds.has(stop.id)}
                  onToggleRota={() => toggleTargetId(stop.id)}
                />
              ))}
            </div>
          </div>
        )}
```

- [ ] **Step 6: Empty-state da rota curada no campo**

No empty-state da lista "Rota Otimizada"/"Rota de hoje" (linha ~253-261), o caso `prospeccao` hoje diz "Selecione uma ou mais cidades…". Agora, quando há cidades mas nenhum alvo marcado, a mensagem deve orientar a marcar. Substituir o ramo `prospeccao`:

```tsx
                  : planningMode === 'prospeccao' ? 'Selecione uma ou mais cidades acima para ver os alvos (clientes + prospects).'
```

por:

```tsx
                  : planningMode === 'prospeccao'
                    ? (fieldTargets.length === 0
                        ? 'Selecione uma ou mais cidades acima para ver os alvos (clientes + prospects).'
                        : 'Marque os alvos que você quer visitar hoje — a rota otimizada aparece aqui.')
```

- [ ] **Step 7: typecheck + lint + test + build**

```bash
bun run typecheck > /tmp/tc.log 2>&1; echo "TC=$?"; tail -3 /tmp/tc.log
bun lint > /tmp/lint.log 2>&1; echo "LINT=$?"; grep -c error /tmp/lint.log
bun run test src/lib/route/ > /tmp/test.log 2>&1; echo "TEST=$?"; tail -3 /tmp/test.log
heavy bun run build > /tmp/build.log 2>&1; echo "BUILD=$?"; tail -3 /tmp/build.log
```
Expected: TC=0, LINT sem novos errors, TEST=0 (~14 testes de field-targets), BUILD=0.

- [ ] **Step 8: Commit**

```bash
git add src/pages/AdminRoutePlanner.tsx src/hooks/useRoutePlanner.ts
git commit -m "feat(roteirizador): curadoria de alvos — universo no mapa, rota só dos marcados + filtro"
```

### Task 3.6: Roadmap, CLAUDE.md, PR final

**Files:**
- Modify: `docs/roadmap-sessao.md`
- Modify: `CLAUDE.md` (§10, bullet do Roteirizador)

- [ ] **Step 1: Atualizar o roadmap da sessão**

Em `docs/roadmap-sessao.md`, marcar a frente "Roteirizador — Visitas em campo" como ✅ (3 sub-PRs entregues) e renderizar no chat ao founder.

- [ ] **Step 2: Adicionar bullet no CLAUDE.md §10**

Acrescentar um bullet documentando: contexto campo/equipe; 100% frontend (reusa RPCs do Radar em prod); multi-cidade via N chamadas à single; curadoria (universo vs rota); limitação conhecida (useFarmerScoring roda em background no campo, não-mexível na v1); ⚠️ requer **Publish** no Lovable.

- [ ] **Step 3: Commit + PR final**

```bash
git add docs/roadmap-sessao.md CLAUDE.md
git commit -m "docs(roteirizador): roadmap + CLAUDE.md da frente Visitas em campo"
git push
gh pr create --title "feat(roteirizador): Visitas em campo — curadoria de alvos (sub-PR 3)" \
  --body "$(cat <<'EOF'
## Sub-PR 3/3 — Curadoria de alvos + rota curada

Fecha a frente "Visitas em campo". Sobre o multi-cidade do sub-PR 2:

- **Resumo** "N alvos: X clientes · Y prospects" + filtro Todos/Clientes/Prospects.
- **Universo de alvos** das cidades no mapa + lista; o hunter **marca quem visitar**.
- **Rota de hoje** = só os marcados, otimizada (nearest-neighbor) e numerada.
- Mapa: marcados em azul numerados; não-marcados na cor do tipo. **fitBounds estável** (não pula ao marcar — guardado por chave de ids).
- 100% frontend (reusa RPCs do Radar em prod). **NÃO toca useFarmerScoring.**

⚠️ **Requer Publish no Lovable** (a feature inteira só vai ao ar com o Publish do frontend; sem migration/edge).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr merge --squash --auto
```

---

## Riscos / limitações conhecidas (registrar; não bloqueiam)

1. **`useFarmerScoring` roda em background no contexto campo.** O hook é chamado incondicionalmente pelo `useRoutePlanner` e não pode ser condicionado (regra dos hooks) nem mexido (restrição money-path). No campo ele não aparece nem bloqueia (a UI é responsiva — `isLoading=authLoading` desde #814). **Follow-up:** extrair a "view equipe" (que usa scoring) para um sub-componente próprio, de modo que o scoring só monte no contexto equipe.
2. **Geocoding capa em 15 alvos por vez (Nominatim).** Com muitas cidades, nem todos os alvos ganham pino no mapa imediatamente; o aviso de "alvos demais" orienta refinar. A lista completa de alvos sempre aparece. Cluster/viewport = v2.
3. **Contagem de clientes por cidade só no resumo (pós-carga), não no seletor.** O seletor mostra o nº de **prospects** por cidade (exato, da RPC `radar_contagem_por_municipio`). Contar clientes por cidade no seletor exigiria cruzar `addresses.city` (texto livre) × `municipio_nome` para 500 cidades (caro e impreciso). O resumo, após carregar, mostra a contagem **real** de clientes + prospects das cidades escolhidas — mais honesto. (Decisão de implementação; comunicar ao founder.)
4. **Toggle de alvo só pela lista (não pelo pino do mapa) na v1.** O mapa destaca os marcados; marcar/desmarcar é pela lista de alvos (canônico). Toggle clicando no pino = v2 (popup-com-botão no Leaflet é frágil).
5. **TOM(RFB) × addresses.city** — a carteira por cidade é aproximada por `ilike` (acento/caixa); prospects são exatos por `municipio_codigo`. Aceito na v1 (founder concordou).

## Self-Review (executado)

- **Cobertura da spec:** navegação 2-contextos (Fase 1 ✓), gating/default por papel (Task 1.5 ✓), equipe intacta (Task 1.6 — bloco equipe = JSX atual ✓), multi-cidade (Fase 2 ✓), clientes+prospects juntos (Task 2.3 ✓), seleção de alvos → rota curada (Fase 3 ✓), resumo + filtro (Task 3.2/3.4 ✓), mapa OSM com cores (Task 3.5 ✓), registrar contato no prospect (já no `RouteStopCard` via `RadarOutcomeMenu` ✓), check-in cliente (já no `RouteStopCard` ✓), Maps/Waze (já no `RouteActionButtons` ✓), aviso de alvos demais (Task 3.2 ✓).
- **Placeholders:** nenhum — todos os steps têm código completo.
- **Consistência de tipos:** `PlanningContext`/`TargetFilter` (types.ts) usados igual no hook, helper e componentes; `selectedCities: CityOption[]`, `selectedTargetIds: Set<string>`, `targetFilter: TargetFilter`; `fieldTargets`/`filteredFieldTargets`/`resumoAlvos`/`stopsParaRota` definidos no hook e consumidos na página com os mesmos nomes. `CityMultiSelector` props (`value`/`onToggle`/`onRemove`) batem com o hook (`selectedCities`/`toggleCity`/`removeCity`).
