# PR 1 — visit-scoring: coluna sem produtor para de virar zero de decisão

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o scoring de missão do Farmer dizer "não avaliada" em vez de calcular 0 sobre colunas que não têm produtor, e criar o gate estrutural que impede a reintrodução do padrão.

**Architecture:** Um helper puro (`potencialConhecido`, quarto irmão de `margemConhecida`/`churnConhecido`) degrada ausência para `null`. As 4 funções de missão passam a devolver `MissionResult { score: number | null, insumosAusentes: string[] }` sob **uma regra única**: `score = null` só quando NENHUM insumo foi medido; senão número + lista de ausentes. Hoje isso torna expansão `null` (todos os insumos ausentes) e recuperação parcial (churn sustenta), que são as duas decisões do founder — sem dois casos especiais. Um registro declarado de colunas-sem-produtor + um vitest que lê a fonte fecham a classe.

**Tech Stack:** TypeScript 5.8 strict · vitest · Deno (edges, lógica espelhada) · Supabase/PostgREST

## Global Constraints

- **Idioma:** código, comentários e mensagens de commit em **pt-BR**.
- **Money-path:** ausente ≠ zero. Nunca fabricar número. `Number(null) === 0` é fabricação.
- **Hazard JS obrigatório:** `null <= 0` é `true`, `null > 50` é `false`. Toda comparação relacional com campo que virou `number | null` precisa de guard explícito **antes** do operador.
- **Lógica DUPLICADA:** `src/lib/visit-scoring/missions.ts` e o inline de `supabase/functions/visit-score-recalc-client/index.ts` (Deno não importa de `src/`). Toda mudança entra nos **dois**.
- **Edges são deploy MANUAL** pelo chat do Lovable, verbatim da main. Merge na main **não** publica.
- **`bun run test:edges` roda com `--no-remote`:** teste de edge não pode ter import remoto (`jsr:`/`npm:`).
- **Arquivo novo em `src/`** precisa de dono em `src/lib/modulos/manifesto.ts` — `src/lib/scoring/**` e `src/lib/visit-scoring/**` já são cobertos; arquivo novo em `src/__tests__/` precisa de verificação.
- **Comandos pesados:** prefixar `heavy` (semáforo de RAM da M2 8GB). `cmd | tail` **engole o exit code** → usar `> log 2>&1; echo $?`.
- **Validação só conta com evidência positiva:** rodar o comando, confirmar que terminou, capturar `exit 0`.
- **Baseline verde ANTES de qualquer sabotagem**, com o TOTAL de testes anotado — em suíte JS o discriminador de "não rodou nada" é o **denominador**.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `src/lib/scoring/potencial.ts` (**novo**) | `potencialConhecido(raw)` → `number \| null`. Irmão de `margin.ts`/`churn.ts`. |
| `src/lib/scoring/__tests__/potencial.test.ts` (**novo**) | Testa o helper, inclusive o hazard relacional. |
| `src/lib/scoring/colunas-sem-produtor.ts` (**novo**) | Registro declarado das colunas sem produtor + medição + data. Fonte do gate. |
| `src/__tests__/colunas-sem-produtor.gate.test.ts` (**novo**) | Gate: lê a fonte de `src/` + `supabase/functions/` e falha em `<coluna> ?? 0`. |
| `src/lib/visit-scoring/types.ts` | `CustomerScoreInputs` nullable; `MissionResult`; `MissionScores`. |
| `src/lib/visit-scoring/missions.ts` | As 4 missões → `MissionResult`; `computeVisitScore` ignora `null` no argmax. |
| `src/lib/visit-scoring/__tests__/missions.test.ts` | Atualiza + acrescenta os casos de ausência. |
| `supabase/functions/visit-score-recalc-client/index.ts` | Espelho da lógica + grava `null` e `insumos_ausentes`. |
| `src/lib/carteira/escopo-clientes.ts` · `src/lib/scoring/agenda.ts` · `src/lib/positivacao/ranking.ts` · `src/hooks/useTacticalPlan.ts` | Consumidores afetados. |
| `supabase/functions/tactical-plans-batch/index.ts` | Consumidor afetado (edge). |
| `src/hooks/useMyVisitSuggestions.ts` · `src/components/dashboard/VisitSuggestionsCard.tsx` | Tela: "não avaliada" em vez de "0". |

---

### Task 1: Helper `potencialConhecido`

**Files:**
- Create: `src/lib/scoring/potencial.ts`
- Test: `src/lib/scoring/__tests__/potencial.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `potencialConhecido(raw: unknown): number | null`

- [ ] **Step 1: Anotar o baseline verde e o TOTAL de testes**

Run:
```bash
heavy bun run test > /tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-adoring-ptolemy-0f65df/9a90e6fd-bcd1-4fd7-b5e4-4070fb380c5d/scratchpad/baseline.log 2>&1; echo "exit=$?"
```
Expected: `exit=0`. Anotar a linha `Tests  N passed (N)` — esse **N** é o denominador que valida toda falsificação depois. Sem ele, "não rodou nada" e "passou" são indistinguíveis.

- [ ] **Step 2: Escrever o teste que falha**

Create `src/lib/scoring/__tests__/potencial.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { potencialConhecido } from '../potencial';

describe('potencialConhecido', () => {
  it('null e undefined são AUSÊNCIA → null', () => {
    expect(potencialConhecido(null)).toBeNull();
    expect(potencialConhecido(undefined)).toBeNull();
  });

  it('0 é CONHECIDO (veredito medido "sem potencial"), não ausência', () => {
    expect(potencialConhecido(0)).toBe(0);
  });

  it('número positivo passa', () => {
    expect(potencialConhecido(42.5)).toBe(42.5);
  });

  it('string numérica do PostgREST (numeric vira string) é aceita', () => {
    expect(potencialConhecido('1000')).toBe(1000);
  });

  it('não-finito degrada para null, jamais para 0', () => {
    expect(potencialConhecido(NaN)).toBeNull();
    expect(potencialConhecido(Infinity)).toBeNull();
    expect(potencialConhecido(-Infinity)).toBeNull();
  });

  it('lixo que Number() coagiria a 0 NÃO vira o veredito "medi e deu zero"', () => {
    // Number('') === 0, Number('  ') === 0, Number(false) === 0, Number([]) === 0.
    // Aceitar isso fabricaria a medição que este helper existe para impedir.
    expect(potencialConhecido('')).toBeNull();
    expect(potencialConhecido('   ')).toBeNull();
    expect(potencialConhecido(false)).toBeNull();
    expect(potencialConhecido([])).toBeNull();
    expect(potencialConhecido({})).toBeNull();
  });

  it('HAZARD: o null que ele devolve NÃO pode ser comparado sem guard', () => {
    // Documenta a armadilha que motiva o helper: em JS `null <= 0` é true.
    // Este teste falha se alguém "simplificar" o helper para devolver 0.
    const ausente = potencialConhecido(null);
    expect(ausente).toBeNull();
    // @ts-expect-error — a comparação direta é o BUG; o TS strict tem que barrá-la.
    expect(ausente <= 0).toBe(true);
  });
});
```

- [ ] **Step 3: Rodar e verificar que FALHA**

Run: `heavy bun run test -- src/lib/scoring/__tests__/potencial.test.ts > /tmp/.../scratchpad/t1.log 2>&1; echo "exit=$?"`
Expected: `exit=1`, com erro de módulo não encontrado (`Cannot find module '../potencial'`). Conferir que o log mostra o arquivo de teste sendo **coletado** — se disser `No test files found`, o filtro está errado e o vermelho não prova nada.

- [ ] **Step 4: Implementar**

Create `src/lib/scoring/potencial.ts`:

```ts
/**
 * Potencial comercial utilizável, ou `null` se não medido.
 *
 * Quarto irmão de `margemConhecida` (`./margin`) e `churnConhecido` (`./churn`), com a mesma
 * semântica e pela mesma razão. Cobre as colunas de `farmer_client_scores` que **nunca tiveram
 * produtor**: `expansion_score`, `revenue_potential`, `recover_score`, `x_score`, `s_score`,
 * `eff_score` — todas `NULL` em 6.633/6.633 linhas (medido 2026-07-27, ver
 * `src/lib/scoring/colunas-sem-produtor.ts`).
 *
 * Diferente dos irmãos, aqui a ausência NÃO é hipótese futura: é 100% da base hoje. O
 * `Number(x ?? 0)` que este helper substitui fabricava um número de decisão para toda a
 * carteira — a missão de expansão sumiu da agenda e 35% do `priority_score` ficou constante
 * desde março de 2026.
 *
 * ⚠️ `0` é CONHECIDO — o veredito "medi e não há potencial". Só null/undefined/NaN/Infinity e
 * lixo coagível são ausência. Confundir os dois é o erro que este helper impede.
 *
 * ⚠️ Fail-closed de propósito, e NÃO `Number.isFinite` puro: `Number('')`, `Number('  ')`,
 * `Number(false)` e `Number([])` são todos **0** — lixo viraria "medi e deu zero".
 *
 * ⚠️ Em comparação relacional o guard é obrigatório: `null <= 0` é `true` e `null > 50` é
 * `false` (null coage a 0), então `if (potencial > 50)` sem checar null classifica como "sem
 * potencial" justamente quem não foi medido.
 *
 * Espelhado em `supabase/functions/visit-score-recalc-client/index.ts` (Deno não importa de
 * `src/`), sob o bloco `// MIRROR-START potencial-conhecido`.
 */
export function potencialConhecido(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
```

- [ ] **Step 5: Rodar e verificar que PASSA**

Run: `heavy bun run test -- src/lib/scoring/__tests__/potencial.test.ts > /tmp/.../scratchpad/t1b.log 2>&1; echo "exit=$?"`
Expected: `exit=0`, `Tests  7 passed (7)`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/scoring/potencial.ts src/lib/scoring/__tests__/potencial.test.ts
git commit -m "feat(scoring): potencialConhecido — ausência de potencial para de virar zero medido [money-path]"
```

---

### Task 2: Tipos — `CustomerScoreInputs` nullable e `MissionResult`

**Files:**
- Modify: `src/lib/visit-scoring/types.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `CustomerScoreInputs.expansion_score: number | null`
  - `CustomerScoreInputs.revenue_potential: number | null`
  - `CustomerScoreInputs.recover_score: number | null`
  - `interface MissionResult { score: number | null; insumosAusentes: string[] }`
  - `type MissionScores = Record<MissionType, MissionResult>`
  - `VisitScore.insumos_ausentes: string[]`

- [ ] **Step 1: Editar os tipos**

Em `src/lib/visit-scoring/types.ts`, dentro de `CustomerScoreInputs`, trocar as três linhas:

```ts
  // de farmer_client_scores
  churn_risk: number;
  // ⚠️ `number | null`: estas três colunas NUNCA tiveram produtor — NULL em 6.633/6.633 linhas
  // (medido 2026-07-27). O tipo `number` anterior MENTIA, e era o que permitia `Number(x ?? 0)`
  // passar despercebido. Ver src/lib/scoring/colunas-sem-produtor.ts.
  expansion_score: number | null;
  health_score: number;
  recover_score: number | null;
  revenue_potential: number | null;
  avg_monthly_spend_180d: number;
  days_since_last_purchase: number;
```

- [ ] **Step 2: Substituir `MissionScores` e estender `VisitScore`**

Trocar o bloco de `MissionScores` por:

```ts
/**
 * Resultado de UMA missão.
 *
 * REGRA ÚNICA (vale para as 4 missões): `score` é `null` somente quando NENHUM insumo da missão
 * foi medido — "não avaliada". Se ao menos um insumo existe, o score é um número e
 * `insumosAusentes` nomeia os que faltaram ("parcial").
 *
 * A regra única substitui dois casos especiais: hoje ela torna a EXPANSÃO `null` (todos os
 * insumos ausentes) e a RECUPERAÇÃO parcial (o churn_risk a sustenta) — que são exatamente os
 * dois desfechos decididos, sem exceção codificada.
 *
 * `insumosAusentes` nomeia a COLUNA (não um booleano) para que, quando um produtor nascer, a
 * lista esvazie sozinha e nada precise ser desligado à mão.
 */
export interface MissionResult {
  score: number | null;
  insumosAusentes: string[];
}

export type MissionScores = Record<MissionType, MissionResult>;
```

E em `VisitScore`, acrescentar o campo **no fim** (preservar a ordem existente):

```ts
export interface VisitScore {
  customer_user_id: string;
  scores: MissionScores;
  visit_score: number;       // = MAX dos scores NÃO-NULOS
  primary_mission: MissionType;
  city: string | null;
  neighborhood: string | null;
  days_since_last_visit: number | null;
  /** União dos insumos ausentes da missão VENCEDORA. Vazio = avaliação completa. */
  insumos_ausentes: string[];
}
```

- [ ] **Step 3: Rodar o typecheck e ver o estrago esperado**

Run: `heavy bun run typecheck > /tmp/.../scratchpad/t2.log 2>&1; echo "exit=$?"`
Expected: `exit=2` (ou ≠0) com erros em `missions.ts`, `mix-selector.ts`, `useMyVisitSuggestions.ts`, `VisitSuggestionsCard.tsx`. **Isso é o objetivo** — o TS strict está listando exatamente os sites que consomem o tipo que mentia. Salvar a lista; ela é a checklist das tasks 3–7.

- [ ] **Step 4: Commit (o typecheck fica vermelho até a Task 4 — commit isolado para bisseção)**

```bash
git add src/lib/visit-scoring/types.ts
git commit -m "refactor(visit-scoring): tipos param de mentir — as 3 colunas sem produtor viram number|null [money-path]"
```

---

### Task 3: `scoreExpansao` e `scoreRecuperacao` sob a regra única

**Files:**
- Modify: `src/lib/visit-scoring/missions.ts`
- Test: `src/lib/visit-scoring/__tests__/missions.test.ts`

**Interfaces:**
- Consumes: `potencialConhecido` (Task 1), `MissionResult` (Task 2).
- Produces: `scoreRecuperacao/scoreExpansao/scoreRelacionamento/scoreProspeccao(c: CustomerScoreInputs): MissionResult`

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar ao fim de `src/lib/visit-scoring/__tests__/missions.test.ts`:

```ts
describe('ausência de insumo (money-path: ausente ≠ zero)', () => {
  it('EXPANSÃO sem nenhum insumo medido → score null, não 0', () => {
    const r = scoreExpansao(mkInput({ expansion_score: null, revenue_potential: null }));
    expect(r.score).toBeNull();
    expect(r.insumosAusentes).toEqual(['expansion_score', 'revenue_potential']);
  });

  it('EXPANSÃO com UM insumo medido → número + o ausente nomeado (parcial)', () => {
    const r = scoreExpansao(mkInput({ expansion_score: 80, revenue_potential: null }));
    expect(r.score).toBeGreaterThan(0);
    expect(r.insumosAusentes).toEqual(['revenue_potential']);
  });

  it('EXPANSÃO com potencial ZERO medido ≠ ausente — 0 é veredito, entra na conta', () => {
    const r = scoreExpansao(mkInput({ expansion_score: 0, revenue_potential: 0 }));
    expect(r.score).toBe(0);
    expect(r.insumosAusentes).toEqual([]);
  });

  it('HAZARD: revenue_potential null NÃO vira 0 via normalizeRevenue (null <= 0 é true)', () => {
    const comZero = scoreExpansao(mkInput({ expansion_score: 50, revenue_potential: 0 }));
    const comNull = scoreExpansao(mkInput({ expansion_score: 50, revenue_potential: null }));
    // Se o null escorregasse para dentro de normalizeRevenue, os dois seriam IDÊNTICOS e
    // "não medido" ficaria indistinguível de "medi e deu zero".
    expect(comZero.insumosAusentes).toEqual([]);
    expect(comNull.insumosAusentes).toEqual(['revenue_potential']);
    expect(comZero.score).toBe(comNull.score); // mesmo número...
    // ...mas com proveniência diferente, que é o ponto.
  });

  it('RECUPERAÇÃO com recover_score ausente segue NUMÉRICA — churn a sustenta', () => {
    const r = scoreRecuperacao(mkInput({
      churn_risk: 90, recover_score: null, days_since_last_purchase: 90,
    }));
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeGreaterThan(0);
    expect(r.insumosAusentes).toEqual(['recover_score']);
  });

  it('RECUPERAÇÃO sem NENHUM insumo (churn_risk 0 e recover null) ainda é medida — churn 0 é dado', () => {
    const r = scoreRecuperacao(mkInput({
      churn_risk: 0, recover_score: null, days_since_last_purchase: 90,
    }));
    expect(r.score).not.toBeNull();
    expect(r.insumosAusentes).toEqual(['recover_score']);
  });

  it('PROSPECÇÃO e RELACIONAMENTO nunca ficam null — insumos sempre presentes', () => {
    const c = mkInput({ expansion_score: null, revenue_potential: null, recover_score: null });
    expect(scoreProspeccao(c).score).not.toBeNull();
    expect(scoreRelacionamento(c).score).not.toBeNull();
    expect(scoreProspeccao(c).insumosAusentes).toEqual([]);
    expect(scoreRelacionamento(c).insumosAusentes).toEqual([]);
  });
});
```

Atualizar também o `mkInput` (topo do arquivo) para refletir o estado REAL de produção:

```ts
    churn_risk: 0,
    expansion_score: null,
    health_score: 50,
    recover_score: null,
    revenue_potential: null,
```

E os 18 testes existentes que passavam `expansion_score`/`recover_score`/`revenue_potential` como número continuam válidos (o override é explícito); os que leem o retorno precisam de `.score` — ajustar cada `expect(score)` para `expect(r.score!)`.

- [ ] **Step 2: Rodar e verificar que FALHA**

Run: `heavy bun run test -- src/lib/visit-scoring/__tests__/missions.test.ts > /tmp/.../scratchpad/t3.log 2>&1; echo "exit=$?"`
Expected: `exit=1`. Conferir que o log mostra os testes **coletados** e o total ≥ 25 — se aparecer `No test files found`, o vermelho é do comando, não do código.

- [ ] **Step 3: Implementar as 4 missões**

Substituir o corpo de `src/lib/visit-scoring/missions.ts` (mantendo o cabeçalho de doc, atualizado):

```ts
import { clamp, normalizeRevenue } from './helpers';
import type {
  CustomerScoreInputs,
  MissionResult,
  MissionScores,
  MissionType,
  VisitScore,
} from './types';

/**
 * Soma os modifiers de uma dimensão. Ausência de sinal = 0 legítimo (não há o que medir),
 * diferente de insumo de score ausente.
 */
function somaModifiers(mods: Array<{ delta: number; decayedWeight: number }> | undefined): number {
  return (mods ?? []).reduce((s, m) => s + m.delta * m.decayedWeight, 0);
}

/**
 * RECUPERAÇÃO — cliente que comprava bem e parou.
 *
 * `recover_score` é `null` em 100% da base (sem produtor). Pela REGRA ÚNICA ela NÃO vira null:
 * `churn_risk` está medido em 6.633/6.633 linhas e sustenta a missão sozinho — 1.111 clientes
 * dependem dela hoje. O ausente é NOMEADO, não fabricado como 0.
 */
export function scoreRecuperacao(c: CustomerScoreInputs): MissionResult {
  const insumosAusentes: string[] = [];
  const churnBoost = c.churn_risk * 0.5;

  // Guard explícito ANTES do uso: `null * 0.3` é 0 em JS, que afirmaria "medi e não há o que
  // recuperar". Sem produtor, o componente simplesmente não entra na soma.
  let recoverBoost = 0;
  if (c.recover_score == null) insumosAusentes.push('recover_score');
  else recoverBoost = c.recover_score * 0.3;

  const recencyPenalty = Math.max(0, 100 - c.days_since_last_purchase) * -0.1;
  const signalsBoost = somaModifiers(c.signal_modifiers?.breakdown?.churn) * 0.1;
  const score = clamp(churnBoost + recoverBoost + recencyPenalty + signalsBoost, 0, 100);
  return { score, insumosAusentes };
}

/**
 * EXPANSÃO — cliente saudável com upsell quente.
 *
 * Os DOIS insumos (`expansion_score`, `revenue_potential`) são `null` em 100% da base e nunca
 * tiveram produtor (`priority_score_log`: 494.699 linhas desde 2026-03-02, componente sempre 0).
 * Pela REGRA ÚNICA, nenhum insumo medido → `score: null` = "não avaliada".
 *
 * Isso NÃO muda comportamento: com os dois zerados sobrava só o signalsBoost, que nunca supera o
 * piso 70 da prospecção no argmax. A missão já não vencia; agora ela diz por quê.
 */
export function scoreExpansao(c: CustomerScoreInputs): MissionResult {
  const insumosAusentes: string[] = [];

  let expansionBase = 0;
  if (c.expansion_score == null) insumosAusentes.push('expansion_score');
  else expansionBase = c.expansion_score * 0.6;

  // ⚠️ Guard ANTES de normalizeRevenue: ele faz `if (value <= 0) return 0`, e `null <= 0` é
  // `true` em JS — o null entraria e sairia como 0 medido, em silêncio. O TS strict também
  // barra (normalizeRevenue declara `value: number`), e essa é a intenção do tipo.
  let revenueBoost = 0;
  if (c.revenue_potential == null) insumosAusentes.push('revenue_potential');
  else revenueBoost = normalizeRevenue(c.revenue_potential) * 20;

  const signalsBoost = somaModifiers(c.signal_modifiers?.breakdown?.expansion) * 0.2;

  // REGRA ÚNICA: nenhum insumo medido → não avaliada. O signalsBoost sozinho não é avaliação de
  // expansão, é ruído de sinal sem base.
  if (insumosAusentes.length === 2) return { score: null, insumosAusentes };

  return { score: clamp(expansionBase + revenueBoost + signalsBoost, 0, 100), insumosAusentes };
}

/**
 * RELACIONAMENTO — cliente VIP saudável precisando manutenção.
 *
 * NOTA DE ESCALA: health_score é 0..100 (vem de calculate-scores). health * 0.5 mapeia
 * 0..100 → contribuição 0..50. Todos os insumos têm produtor → nunca fica null.
 */
export function scoreRelacionamento(c: CustomerScoreInputs): MissionResult {
  const healthBoost = c.health_score * 0.5;
  const revenueBoost = normalizeRevenue(c.avg_monthly_spend_180d) * 30;
  // null = nunca visitado: fallback conservador (30d) para não inflar score de relacionamento
  // sem histórico de visita real.
  const effectiveDays = c.days_since_last_visit ?? 30;
  const daysSinceVisitBoost = Math.min(40, effectiveDays * 0.3);
  const riskPenalty = c.churn_risk * 0.3;
  const score = clamp(healthBoost + revenueBoost + daysSinceVisitBoost - riskPenalty, 0, 100);
  return { score, insumosAusentes: [] };
}

/** PROSPECÇÃO — lead novo ou cliente sem histórico. Insumos sempre presentes. */
export function scoreProspeccao(c: CustomerScoreInputs): MissionResult {
  const isProspectCandidate = c.sales_orders_count === 0 || c.is_prospect === true;
  if (!isProspectCandidate) return { score: 0, insumosAusentes: [] };
  const baseProspect = 70;
  const recencyOfSignup = c.days_since_signup < 30 ? 20 : 0;
  const signalsQuality = (c.signal_modifiers?.source_call_count ?? 0) > 0 ? 10 : 0;
  return { score: clamp(baseProspect + recencyOfSignup + signalsQuality, 0, 100), insumosAusentes: [] };
}
```

- [ ] **Step 4: Rodar e verificar que PASSA**

Run: `heavy bun run test -- src/lib/visit-scoring/__tests__/missions.test.ts > /tmp/.../scratchpad/t3b.log 2>&1; echo "exit=$?"`
Expected: `exit=0`, total ≥ 25.

- [ ] **Step 5: Commit**

```bash
git add src/lib/visit-scoring/missions.ts src/lib/visit-scoring/__tests__/missions.test.ts
git commit -m "fix(visit-scoring): expansão sem insumo vira 'não avaliada' em vez de zero calculado [money-path]"
```

---

### Task 4: `computeVisitScore` — argmax que ignora `null`

**Files:**
- Modify: `src/lib/visit-scoring/missions.ts`
- Test: `src/lib/visit-scoring/__tests__/missions.test.ts`

**Interfaces:**
- Consumes: `MissionResult` (Task 2), as 4 missões (Task 3).
- Produces: `computeVisitScore(c: CustomerScoreInputs): VisitScore` com `insumos_ausentes`.

- [ ] **Step 1: Escrever os testes que falham**

```ts
describe('computeVisitScore com missão não avaliada', () => {
  it('missão null NÃO empata com 0 no argmax — é ignorada', () => {
    const r = computeVisitScore(mkInput({
      expansion_score: null, revenue_potential: null,
      sales_orders_count: 0, // vira candidato a prospecção (piso 70)
    }));
    expect(r.scores.expansao.score).toBeNull();
    expect(r.primary_mission).toBe('prospeccao');
    expect(r.visit_score).toBe(70);
  });

  it('expansão MEDIDA e vencedora ainda ganha o tiebreak (a ordem não regrediu)', () => {
    const r = computeVisitScore(mkInput({
      expansion_score: 100, revenue_potential: 10000,
      sales_orders_count: 5, is_prospect: false, health_score: 0, churn_risk: 0,
    }));
    expect(r.primary_mission).toBe('expansao');
    expect(r.insumos_ausentes).toEqual([]);
  });

  it('insumos_ausentes reporta os da missão VENCEDORA, não a união de todas', () => {
    const r = computeVisitScore(mkInput({
      churn_risk: 100, recover_score: null, days_since_last_purchase: 200,
      expansion_score: null, revenue_potential: null,
      sales_orders_count: 5, is_prospect: false, health_score: 0,
    }));
    expect(r.primary_mission).toBe('recuperacao');
    expect(r.insumos_ausentes).toEqual(['recover_score']);
  });

  it('visit_score nunca é null — prospecção sempre fornece um número', () => {
    const r = computeVisitScore(mkInput({
      expansion_score: null, revenue_potential: null, recover_score: null,
    }));
    expect(typeof r.visit_score).toBe('number');
  });
});
```

- [ ] **Step 2: Rodar e verificar que FALHA**

Run: `heavy bun run test -- src/lib/visit-scoring/__tests__/missions.test.ts > /tmp/.../scratchpad/t4.log 2>&1; echo "exit=$?"`
Expected: `exit=1`, total ≥ 29.

- [ ] **Step 3: Implementar**

Substituir `computeVisitScore` em `src/lib/visit-scoring/missions.ts`:

```ts
/**
 * Computa o visit_score final + primary_mission.
 * Tiebreak: expansao > recuperacao > relacionamento > prospeccao.
 *
 * ⚠️ Missão com `score: null` ("não avaliada") é IGNORADA no argmax — não tratada como 0. Tratar
 * como 0 a faria empatar com missões legitimamente zeradas e reintroduziria a fabricação pela
 * porta dos fundos.
 */
export function computeVisitScore(c: CustomerScoreInputs): VisitScore {
  const scores: MissionScores = {
    recuperacao: scoreRecuperacao(c),
    expansao: scoreExpansao(c),
    relacionamento: scoreRelacionamento(c),
    prospeccao: scoreProspeccao(c),
  };

  const ORDER: MissionType[] = ['expansao', 'recuperacao', 'relacionamento', 'prospeccao'];

  // Semente na prospecção, que nunca é null (insumos sempre presentes).
  let primary_mission: MissionType = 'prospeccao';
  let visit_score = scores.prospeccao.score ?? 0;

  for (const m of ORDER) {
    const s = scores[m].score;
    if (s == null) continue; // não avaliada: fora da disputa, jamais como 0
    if (s > visit_score) {
      visit_score = s;
      primary_mission = m;
    }
  }

  return {
    customer_user_id: c.customer_user_id,
    scores,
    visit_score,
    primary_mission,
    city: c.city,
    neighborhood: c.neighborhood,
    days_since_last_visit: c.days_since_last_visit,
    insumos_ausentes: scores[primary_mission].insumosAusentes,
  };
}
```

- [ ] **Step 4: Rodar e verificar que PASSA**

Run: `heavy bun run test -- src/lib/visit-scoring/__tests__/missions.test.ts > /tmp/.../scratchpad/t4b.log 2>&1; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/visit-scoring/missions.ts src/lib/visit-scoring/__tests__/missions.test.ts
git commit -m "fix(visit-scoring): missão não avaliada sai do argmax em vez de empatar como zero [money-path]"
```

---

### Task 5: Consumidores em `src/` — `mix-selector`, `escopo-clientes`, `agenda`, `ranking`, `useTacticalPlan`

**Files:**
- Modify: `src/lib/visit-scoring/mix-selector.ts`
- Modify: `src/lib/carteira/escopo-clientes.ts:190`
- Modify: `src/lib/scoring/agenda.ts:108`
- Modify: `src/lib/positivacao/ranking.ts:8`
- Modify: `src/hooks/useTacticalPlan.ts:432-433`
- Test: `src/lib/scoring/__tests__/agenda.test.ts`

**Interfaces:**
- Consumes: `potencialConhecido` (Task 1), `MissionResult`/`VisitScore` (Tasks 2–4).
- Produces: nada novo.

- [ ] **Step 1: Escrever o teste que falha (agenda — o site com efeito visível)**

Acrescentar em `src/lib/scoring/__tests__/agenda.test.ts`:

```ts
describe('agenda: expansão sem insumo (money-path)', () => {
  it('expansion_score null NÃO classifica como follow_up por fabricação de zero', () => {
    // `expansion > 50` com `expansion = null ?? 0` é sempre false → o tipo 'expansao' virou
    // CÓDIGO MORTO em produção (0 de 6.633 clientes). Com o guard, a ausência é explícita.
    const [item] = buildAgendaItems([mkRow({
      expansion_score: null, churn_risk: 10, health_class: 'estavel',
      sales_history_status: 'com_historico',
    })]);
    expect(item.agenda_type).toBe('follow_up');
    expect(item.insumo_expansao_ausente).toBe(true);
  });

  it('expansion_score medido acima de 50 ainda classifica como expansao', () => {
    const [item] = buildAgendaItems([mkRow({
      expansion_score: 80, churn_risk: 10, health_class: 'estavel',
      sales_history_status: 'com_historico',
    })]);
    expect(item.agenda_type).toBe('expansao');
    expect(item.insumo_expansao_ausente).toBe(false);
  });
});
```

> Se `mkRow` não existir no arquivo, criar um helper local espelhando o `mkInput` de `missions.test.ts`, com os campos de `CarteiraRow`.

- [ ] **Step 2: Rodar e verificar que FALHA**

Run: `heavy bun run test -- src/lib/scoring/__tests__/agenda.test.ts > /tmp/.../scratchpad/t5.log 2>&1; echo "exit=$?"`
Expected: `exit=1`.

- [ ] **Step 3: Corrigir `agenda.ts`**

Em `src/lib/scoring/agenda.ts`, dentro de `buildAgendaItems`:

```ts
    const base = s.priority_score ?? 0;
    const churn = s.churn_risk ?? 0;
    // ⚠️ Guard explícito: `(s.expansion_score ?? 0) > 50` é SEMPRE false quando a coluna é null —
    // e ela é null em 6.633/6.633 linhas, o que fez o tipo 'expansao' virar código morto em
    // produção. Sem produtor não há expansão a afirmar; o ausente é reportado, não fabricado.
    const expansion = potencialConhecido(s.expansion_score);
    const insumo_expansao_ausente = expansion == null;
    let agenda_type: AgendaItem['agenda_type'] = 'follow_up';
    if (s.sales_history_status === 'sem_historico') {
      agenda_type = 'ativacao';
    } else if (churn > 50 || s.health_class === 'critico' || s.health_class === 'atencao') {
      agenda_type = 'risco';
    } else if (expansion != null && expansion > 50) {
      agenda_type = 'expansao';
    }
```

E acrescentar `insumo_expansao_ausente` ao objeto retornado e à interface `AgendaItem`:

```ts
  /** true = expansão não pôde ser avaliada (coluna sem produtor), ≠ "avaliei e não é expansão". */
  insumo_expansao_ausente: boolean;
```

- [ ] **Step 4: Corrigir `escopo-clientes.ts:190` — o irmão que o #1565 deixou**

```ts
      health_score: s.health_score ?? 0,
      // O #1565 corrigiu `churn_risk` NESTE mesmo map.set e deixou a linha abaixo. Coagir na
      // fronteira torna inertes os guards de quem lê o mapa (#1498) — mesma razão, mesmo helper.
      expansion_score: potencialConhecido(s.expansion_score),
```

Ajustar o tipo do campo em `ClientScore` (ou equivalente no arquivo) para `number | null`.

- [ ] **Step 5: Corrigir `ranking.ts:8`**

```ts
export function rankAPositivar(candidatos: ClienteAPositivar[]): ClienteAPositivar[] {
  return [...candidatos].sort((a, b) => {
    const ps = (b.priority_score ?? 0) - (a.priority_score ?? 0);
    if (ps !== 0) return ps;
    // ⚠️ Desempate por potencial só vale entre valores MEDIDOS. Com a coluna null em 100% da base,
    // `?? 0` fazia todo mundo empatar em 0 — inerte, mas silenciosamente: quando um produtor
    // nascer, cliente sem potencial medido seria ordenado como "potencial zero". Ausente sai do
    // critério e cai para o próximo desempate.
    const rpB = potencialConhecido(b.revenue_potential);
    const rpA = potencialConhecido(a.revenue_potential);
    if (rpA != null && rpB != null) {
      const rp = rpB - rpA;
      if (rp !== 0) return rp;
    }
    return (b.churn_risk ?? 0) - (a.churn_risk ?? 0);
  });
}
```

- [ ] **Step 6: Corrigir `useTacticalPlan.ts:432-433`**

```ts
      // Sem produtor, `Number(x || 0)` afirmava potencial ZERO para toda a carteira e essa
      // afirmação virava texto de plano gerado por IA. Ausente é ausente.
      const expansionPotential = potencialConhecido(score.expansion_score);
      const revenuePotential = potencialConhecido(score.revenue_potential);
```

Seguir os erros do `typecheck` para ajustar os usos a jusante — em cada um, ausente deve degradar para "não informado" no prompt/objetivo, **nunca** para 0.

- [ ] **Step 7: `mix-selector.ts` — sem mudança de lógica, só de tipo**

`pickDailyMix` usa `c.primary_mission` e `c.visit_score`, que continuam não-nulos. Confirmar que compila; se o typecheck acusar, é porque algum acesso a `scores.X` virou `MissionResult` — trocar por `scores.X.score`.

- [ ] **Step 8: Rodar typecheck + testes**

Run:
```bash
heavy bun run typecheck > /tmp/.../scratchpad/t5b.log 2>&1; echo "typecheck=$?"
heavy bun run test > /tmp/.../scratchpad/t5c.log 2>&1; echo "test=$?"
```
Expected: ambos `=0`. O total de testes tem de ser ≥ baseline da Task 1 + 13.

- [ ] **Step 9: Commit**

```bash
git add src/lib/visit-scoring/mix-selector.ts src/lib/carteira/escopo-clientes.ts src/lib/scoring/agenda.ts src/lib/positivacao/ranking.ts src/hooks/useTacticalPlan.ts src/lib/scoring/__tests__/agenda.test.ts
git commit -m "fix(farmer): 5 consumidores param de ler potencial ausente como zero medido [money-path]"
```

---

### Task 6: Tela — "não avaliada" em vez de "0"

**Files:**
- Modify: `src/hooks/useMyVisitSuggestions.ts:136-148`
- Modify: `src/components/dashboard/VisitSuggestionsCard.tsx:100-104`

**Interfaces:**
- Consumes: `VisitScore.scores` como `MissionScores` (Task 2).
- Produces: nada novo.

- [ ] **Step 1: Ajustar o mapeamento do hook**

Em `src/hooks/useMyVisitSuggestions.ts`, o `.select` já traz as 4 colunas. A coluna
`customer_visit_scores.expansao_score` é `nullable` (conferido: `is_nullable = YES`), então o
`null` gravado pela edge chega intacto. Trocar o bloco `scores:`:

```ts
      const visitScores: VisitScore[] = scores.map(s => ({
        customer_user_id: s.customer_user_id,
        scores: {
          // `?? []` só no array de ausentes; o SCORE preserva o null da coluna — coagir aqui
          // desfaria, na borda de leitura, exatamente o que a edge acabou de gravar com honestidade.
          recuperacao: { score: s.recuperacao_score, insumosAusentes: [] },
          expansao: { score: s.expansao_score, insumosAusentes: [] },
          relacionamento: { score: s.relacionamento_score, insumosAusentes: [] },
          prospeccao: { score: s.prospeccao_score, insumosAusentes: [] },
        },
        visit_score: s.visit_score,
        primary_mission: s.primary_mission,
        city: s.city,
        neighborhood: s.neighborhood,
        days_since_last_visit: s.days_since_last_visit,
        insumos_ausentes: [],
      }));
```

E na interface local do hook (linha ~104), trocar os 4 campos de `number` para `number | null`.

- [ ] **Step 2: Ajustar o tooltip do card**

Em `src/components/dashboard/VisitSuggestionsCard.tsx`, acrescentar o formatador acima do `return` do componente:

```tsx
/** Score de missão para exibição. `null` = não avaliada (insumo sem produtor), ≠ zero medido. */
const fmtMissao = (v: number | null) => (v == null ? 'não avaliada' : String(Math.round(v)));
```

E trocar as duas linhas do tooltip:

```tsx
                      <div className="text-muted-foreground">
                        Recuperação: {fmtMissao(s.scores.recuperacao.score)} · Expansão: {fmtMissao(s.scores.expansao.score)}
                      </div>
                      <div className="text-muted-foreground">
                        Relacionamento: {fmtMissao(s.scores.relacionamento.score)} · Prospecção: {fmtMissao(s.scores.prospeccao.score)}
                      </div>
```

- [ ] **Step 3: Rodar typecheck + testes**

Run:
```bash
heavy bun run typecheck > /tmp/.../scratchpad/t6.log 2>&1; echo "typecheck=$?"
heavy bun run test > /tmp/.../scratchpad/t6b.log 2>&1; echo "test=$?"
```
Expected: ambos `=0`.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useMyVisitSuggestions.ts src/components/dashboard/VisitSuggestionsCard.tsx
git commit -m "feat(farmer): tela distingue 'expansão não avaliada' de 'expansão zero' [money-path]"
```

---

### Task 7: Edges — espelho da lógica em `visit-score-recalc-client` e `tactical-plans-batch`

**Files:**
- Modify: `supabase/functions/visit-score-recalc-client/index.ts:56-160, 224-266`
- Modify: `supabase/functions/tactical-plans-batch/index.ts:159`
- Modify: `src/lib/scoring/potencial.ts` (marcadores MIRROR)
- Test: `src/__tests__/edge-money-path-invariants.test.ts`

**Interfaces:**
- Consumes: a lógica das Tasks 3–4 (a ser espelhada verbatim).
- Produces: bloco `// MIRROR-START potencial-conhecido` em ambos os lados.

- [ ] **Step 1: Marcar o bloco espelhado em `src/lib/scoring/potencial.ts`**

Envolver a função (não o JSDoc) com os marcadores:

```ts
// MIRROR-START potencial-conhecido — espelhado verbatim em supabase/functions/visit-score-recalc-client/index.ts
export function potencialConhecido(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
// MIRROR-END
```

- [ ] **Step 2: Escrever o teste de paridade que falha**

Acrescentar em `src/__tests__/edge-money-path-invariants.test.ts`:

```ts
describe('visit-score-recalc-client: paridade do potencialConhecido', () => {
  const VISIT_EDGE = 'supabase/functions/visit-score-recalc-client/index.ts';
  const POTENCIAL = 'src/lib/scoring/potencial.ts';

  it('o bloco MIRROR do helper é idêntico no src e no edge', () => {
    expect(mirrorBlockNamed(read(VISIT_EDGE), 'potencial-conhecido'))
      .toBe(mirrorBlockNamed(read(POTENCIAL), 'potencial-conhecido'));
  });

  it('o edge NÃO coage as 3 colunas sem produtor com ?? 0', () => {
    const src = read(VISIT_EDGE);
    // Âncora ASCII e exclusiva do ramo errado (money-path: acento é armadilha de padrão).
    expect(src).not.toMatch(/expansion_score\s*\?\?\s*0/);
    expect(src).not.toMatch(/recover_score\s*\?\?\s*0/);
    expect(src).not.toMatch(/revenue_potential\s*\?\?\s*0/);
  });

  it('DETECTOR: o assert acima enxerga o padrão quando ele existe', () => {
    // Sem este par, "não tem o padrão" e "o regex está quebrado" têm o mesmo output verde.
    const amostra = 'expansion_score: Number(scores.expansion_score ?? 0),';
    expect(amostra).toMatch(/expansion_score\s*\?\?\s*0/);
  });
});
```

> O terceiro teste é o **detector par** exigido pelo `money-path.md` (#1488/#1579): assert de ausência sem detector é tautologia verde.

- [ ] **Step 3: Rodar e verificar que FALHA**

Run: `heavy bun run test -- src/__tests__/edge-money-path-invariants.test.ts > /tmp/.../scratchpad/t7.log 2>&1; echo "exit=$?"`
Expected: `exit=1` — o bloco MIRROR ainda não existe no edge (erro `bloco // MIRROR-START potencial-conhecido.../END não encontrado`) e o `?? 0` ainda está lá.

- [ ] **Step 4: Espelhar no edge**

Em `supabase/functions/visit-score-recalc-client/index.ts`, na seção `--- Inline helpers ---`, acrescentar:

```ts
// MIRROR-START potencial-conhecido — espelhado verbatim de src/lib/scoring/potencial.ts
function potencialConhecido(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
// MIRROR-END
```

Nos `--- Inline types ---`, tornar as 3 colunas nullable em `CustomerScoreInputs` e trocar
`Record<MissionType, number>` pelo `MissionResult` espelhado:

```ts
interface MissionResult {
  score: number | null;
  insumosAusentes: string[];
}
```

Espelhar `scoreRecuperacao`/`scoreExpansao`/`scoreRelacionamento`/`scoreProspeccao` e
`computeVisitScore` **verbatim** das Tasks 3–4, preservando o parâmetro `classesAtivas` e o
`aplicaveis(...)` que só existem no edge (FA4 shadow-mode).

Em `recalcOne`, trocar as 3 coerções (linhas ~228-231):

```ts
    churn_risk: Number(scores.churn_risk ?? 0),
    expansion_score: potencialConhecido(scores.expansion_score),
    health_score: Number(scores.health_score ?? 0),
    recover_score: potencialConhecido(scores.recover_score),
    revenue_potential: potencialConhecido(scores.revenue_potential),
```

No `upsert`, gravar `null` de verdade e persistir os ausentes:

```ts
    recuperacao_score: result.scores.recuperacao.score,
    expansao_score: result.scores.expansao.score,
    relacionamento_score: result.scores.relacionamento.score,
    prospeccao_score: result.scores.prospeccao.score,
```

E dentro de `score_breakdown`, acrescentar:

```ts
    insumos_ausentes: result.insumos_ausentes,
```

> `score_breakdown` tem **um único writer** (esta edge) e o upsert reescreve o objeto inteiro —
> conferido antes de escolher o jsonb (CLAUDE.md: sinal money-path nunca em jsonb multi-writer).

- [ ] **Step 5: Corrigir `tactical-plans-batch/index.ts:159`**

```ts
      priority: Number(r.priority_score ?? 0),
      // Sem produtor, `?? 0` afirmava potencial zero para toda a carteira, e essa afirmação
      // alimentava o ranking do batch de planos. Ausente sai do critério.
      rev: potencialConhecido(r.revenue_potential),
      avg: Number(r.avg_monthly_spend_180d ?? 0),
```

Acrescentar o helper inline nesta edge também (bloco próprio, sem MIRROR — a paridade textual
vigiada é a do `visit-score-recalc-client`) e ajustar os usos de `rev` a jusante com guard
explícito antes de qualquer comparação relacional.

- [ ] **Step 6: Rodar os 4 gates**

Run:
```bash
heavy bun run typecheck  > /tmp/.../scratchpad/t7a.log 2>&1; echo "typecheck=$?"
heavy bun run test       > /tmp/.../scratchpad/t7b.log 2>&1; echo "test=$?"
heavy bun run test:edges > /tmp/.../scratchpad/t7c.log 2>&1; echo "edges=$?"
heavy bun run lint       > /tmp/.../scratchpad/t7d.log 2>&1; echo "lint=$?"
```
Expected: todos `=0`. **Esperar os quatro** — não commitar prevendo o verde de um gate que ainda não fechou.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/visit-score-recalc-client/index.ts supabase/functions/tactical-plans-batch/index.ts src/lib/scoring/potencial.ts src/__tests__/edge-money-path-invariants.test.ts
git commit -m "fix(edge): visit-score e tactical-batch gravam ausência como null, com paridade vigiada [money-path]"
```

---

### Task 8: O GATE — registro de colunas sem produtor + vitest que lê a fonte

**Files:**
- Create: `src/lib/scoring/colunas-sem-produtor.ts`
- Create: `src/__tests__/colunas-sem-produtor.gate.test.ts`
- Modify: `src/lib/modulos/manifesto.ts` (se `src/__tests__/**` não tiver dono)

**Interfaces:**
- Consumes: nada.
- Produces: `COLUNAS_SEM_PRODUTOR: readonly string[]`

- [ ] **Step 1: Criar o registro**

```ts
/**
 * Colunas de `farmer_client_scores` que NÃO TÊM PRODUTOR — a ausência delas é o estado normal,
 * não uma exceção.
 *
 * Este arquivo é a fonte do gate `src/__tests__/colunas-sem-produtor.gate.test.ts`, que proíbe
 * `<coluna> ?? 0` e `<coluna> || 0` em `src/` e `supabase/functions/`.
 *
 * POR QUE UM REGISTRO, E NÃO UMA REGRA GENÉRICA CONTRA `?? 0`:
 * `?? 0` é LEGÍTIMO sobre coluna com produtor e `column_default = 0` — ali nunca dispara e é
 * defesa dormente (o caso `gross_margin_pct` antes do #1495). A classe não é o operador, é o
 * operador SOBRE COLUNA SEM PRODUTOR. Só a medição separa os dois.
 *
 * MEDIÇÃO (psql-ro, produção, 2026-07-27) — `count(*) = 6.633`:
 *
 *   coluna              nulos  zeros  positivos  column_default
 *   expansion_score      6633      0          0  (nenhum)
 *   recover_score        6633      0          0  (nenhum)
 *   revenue_potential    6633      0          0  (nenhum)
 *   x_score              6633      0          0  (nenhum)
 *   s_score              6633      0          0  (nenhum)
 *   eff_score            6633      0          0  (nenhum)
 *
 * Corroboração independente: `priority_score_log` tem 494.699 linhas desde 2026-03-02 com
 * `margin_potential_component = 0` em TODAS — `revenue_potential` nunca teve produtor, não é
 * regressão recente.
 *
 * COMO SAIR DESTA LISTA: quando um produtor nascer, re-rodar a pré-flight
 * (`count(*) FILTER (WHERE col IS NULL)` + `column_default`) e remover a coluna daqui com a
 * medição nova no commit. O gate libera os sites daquela coluna automaticamente.
 *
 * `m_score` e `gross_margin_pct` NÃO entram: têm produtor (1.058 e 1.059 positivos) e já são
 * cobertas por `margemConhecida`.
 */
export const COLUNAS_SEM_PRODUTOR = [
  'expansion_score',
  'recover_score',
  'revenue_potential',
  'x_score',
  's_score',
  'eff_score',
] as const;
```

- [ ] **Step 2: Escrever o gate**

Create `src/__tests__/colunas-sem-produtor.gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { COLUNAS_SEM_PRODUTOR } from '@/lib/scoring/colunas-sem-produtor';

// repo root: src/__tests__ → src → repo (2 níveis).
const CWD = resolve(__dirname, '../..');

// Lê a FONTE (não executa): pega também as edges Deno, que o vitest não roda. Mesmo padrão de
// edge-money-path-invariants.test.ts.
function arquivosTs(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(CWD, dir))) {
    if (nome === 'node_modules' || nome === 'dist' || nome.startsWith('.')) continue;
    const rel = join(dir, nome);
    const abs = resolve(CWD, rel);
    if (statSync(abs).isDirectory()) arquivosTs(rel, acc);
    else if (/\.tsx?$/.test(nome) && !/\.(test|spec)\.tsx?$|_test\.ts$/.test(nome)) acc.push(rel);
  }
  return acc;
}

const ALVOS = [...arquivosTs('src'), ...arquivosTs('supabase/functions')];

// Âncora ASCII, sem `-i`, exclusiva do ramo errado (money-path: acento e caixa são armadilha).
const padrao = (col: string) => new RegExp(`\\b${col}\\b[^,;)\\n]*(\\?\\?|\\|\\|)\\s*0(?![.0-9])`);

describe('gate: coluna sem produtor não pode ser coagida para 0', () => {
  it('varre o repo inteiro (denominador: prova que a varredura rodou)', () => {
    // Sem esta asserção, um glob quebrado varreria 0 arquivos e o gate passaria VERDE — o
    // "não rodou nada" que se lê como aprovação (money-path: em JS o discriminador é o
    // denominador). Piso medido em 2026-07-27: 1.545 arquivos .ts/.tsx não-teste em
    // `src/` + `supabase/functions/`. O piso é folgado de propósito — ele detecta glob
    // QUEBRADO, não deleção legítima de arquivos.
    expect(ALVOS.length).toBeGreaterThan(1000);
  });

  for (const col of COLUNAS_SEM_PRODUTOR) {
    it(`nenhum site coage \`${col}\` para 0`, () => {
      const infratores = ALVOS.filter((f) => padrao(col).test(readFileSync(resolve(CWD, f), 'utf8')));
      expect(infratores).toEqual([]);
    });
  }

  it('DETECTOR: o padrão casa a forma proibida quando ela existe', () => {
    // Par obrigatório do assert de ausência (money-path #1488/#1579): sem ele, "está limpo" e
    // "o regex está quebrado" produzem o mesmo verde.
    expect(padrao('expansion_score').test('Number(scores.expansion_score ?? 0)')).toBe(true);
    expect(padrao('revenue_potential').test('const rp = score.revenue_potential || 0;')).toBe(true);
    // E NÃO casa a forma legítima (coluna com produtor, fora do registro).
    expect(padrao('expansion_score').test('potencialConhecido(s.expansion_score)')).toBe(false);
  });
});
```

- [ ] **Step 3: Rodar e verificar que PASSA (a erradicação das Tasks 3–7 já ocorreu)**

Run: `heavy bun run test -- src/__tests__/colunas-sem-produtor.gate.test.ts > /tmp/.../scratchpad/t8.log 2>&1; echo "exit=$?"`
Expected: `exit=0`, `Tests  8 passed (8)` (1 denominador + 6 colunas + 1 detector).

Se algum vier vermelho, é site afetado que escapou da varredura — corrigir antes de seguir.

- [ ] **Step 4: FALSIFICAR o gate (sem isto ele é decoração)**

Reintroduzir o padrão de propósito, provar que a sabotagem APLICOU, e exigir o vermelho:

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/adoring-ptolemy-0f65df
SCRATCH=/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-adoring-ptolemy-0f65df/9a90e6fd-bcd1-4fd7-b5e4-4070fb380c5d/scratchpad
ALVO=src/lib/scoring/agenda.ts
cp "$ALVO" "$SCRATCH/agenda.orig"
trap 'cp "$SCRATCH/agenda.orig" "$ALVO"' EXIT
perl -pi -e 's/potencialConhecido\(s\.expansion_score\)/(s.expansion_score ?? 0)/' "$ALVO"
command grep -q 'expansion_score ?? 0' "$ALVO" && echo "SABOTAGEM APLICADA" || { echo "SABOTAGEM NAO APLICOU - falsificacao INVALIDA"; exit 1; }
heavy bun run test -- src/__tests__/colunas-sem-produtor.gate.test.ts > "$SCRATCH/falsif.log" 2>&1; echo "exit=$?"
command grep -E "Tests +[0-9]+ failed" "$SCRATCH/falsif.log"
cp "$SCRATCH/agenda.orig" "$ALVO"; trap - EXIT
command grep -q 'potencialConhecido(s.expansion_score)' "$ALVO" && echo "RESTAURADO"
```

Expected:
- `SABOTAGEM APLICADA`
- `exit=1`
- **`Tests  1 failed | 7 passed (8)`** — exatamente **1** vermelho, o de `expansion_score`, e o denominador **(8)** intacto. Denominador diferente de 8 = a sabotagem quebrou o parser e o vermelho não é do assert (o teste que devia julgar nem existiu).
- `RESTAURADO`

> ⚠️ Enquanto a sabotagem estiver aplicada, `git status` mostra `agenda.ts` modificado. **Não
> commitar nem rodar `git add -A` nesta janela.** Confirmar `RESTAURADO` e `git diff --name-only`
> vazio antes de seguir.

- [ ] **Step 5: Confirmar a árvore limpa e commitar**

```bash
git diff --name-only   # tem de estar VAZIO
git add src/lib/scoring/colunas-sem-produtor.ts src/__tests__/colunas-sem-produtor.gate.test.ts
git commit -m "test(gate): coluna sem produtor não pode virar zero — gate estrutural falsificado [money-path]"
```

---

### Task 9: Gates completos, PR e watcher

**Files:** nenhum (verificação e entrega).

- [ ] **Step 1: Rodar os 5 gates do CI, com evidência positiva**

```bash
SCRATCH=/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-adoring-ptolemy-0f65df/9a90e6fd-bcd1-4fd7-b5e4-4070fb380c5d/scratchpad
heavy bun run typecheck  > "$SCRATCH/g1.log" 2>&1; echo "typecheck=$?"
heavy bun run test       > "$SCRATCH/g2.log" 2>&1; echo "test=$?"
heavy bun run test:edges > "$SCRATCH/g3.log" 2>&1; echo "edges=$?"
heavy bun run lint       > "$SCRATCH/g4.log" 2>&1; echo "lint=$?"
bunx knip                > "$SCRATCH/g5.log" 2>&1; echo "knip=$?"
```
Expected: os cinco `=0`. Conferir a linha de total em `g2.log` — tem de ser ≥ baseline da Task 1 + ~21.

- [ ] **Step 2: RE-conferir colisão imediatamente antes do `gh pr create`**

```bash
git fetch origin --quiet
gh pr list --state open --limit 30 --json number,title,headRefName --jq '.[] | "\(.number) \(.title)"'
git log --oneline HEAD..origin/main
```
Se algum PR tocar `visit-scoring`, `farmer_client_scores`, `agenda.ts` ou as edges deste plano,
**parar e coordenar** — a checagem do início da sessão vence, e o auto-merge fecha PR em minutos.

- [ ] **Step 3: Abrir o PR**

Corpo obrigatório (o passo 0 do `matar-classe` exige a linha explícita):

```
**Instância única ou classe?** CLASSE — `?? 0`/`|| 0` sobre coluna de `farmer_client_scores` sem
produtor. Assinatura calibrada com controle pré/pós-fix do #1565; varredura do repo inteiro:
64 sites → 47 falsos-positivos (colunas dormentes) + 4 já-corretos + 13 afetados. Gate estrutural
em `src/__tests__/colunas-sem-produtor.gate.test.ts`, falsificado. PR 2 (calculate-scores) e PR 3
(registro) seguem na mesma sessão.
```

Listar no corpo **os sites varridos inclusive os limpos** (prova de varredura completa, não de
amostra) e as **3 pendências manuais do founder**:

1. **Deploy da edge `visit-score-recalc-client`** pelo chat do Lovable, verbatim da main.
2. **Deploy da edge `tactical-plans-batch`**, idem.
3. **Publish do frontend** no editor do Lovable.

- [ ] **Step 4: Armar o watcher em background**

```bash
scripts/pr-watch.sh <nº>
```
(Bash com `run_in_background: true`.) No desfecho, avisar via PushNotification. **Exit 6 ≠ 5:**
6 = não consegui consultar → confirmar com `gh pr view <nº>` antes de reportar.

- [ ] **Step 5: Após o merge, conferir que o sync do Lovable não reverteu**

```bash
git fetch origin --quiet
git log -S 'potencialConhecido' --oneline origin/main -- supabase/functions/visit-score-recalc-client/index.ts
```
Expected: o commit do merge aparece. Se sumir depois, o "Changes" do bot atropelou (#1445→#1478,
#1586) → restaurar por PR **antes** de pedir o deploy.

---

## Self-Review

**Cobertura da spec:** §4.1 helper → Task 1. §4.2 tipos + hazard → Tasks 2, 3. §4.3 missões
(expansão fail-closed, recuperação parcial) → Tasks 3, 4. §4.4 tela → Task 6. §4.5 gate +
falsificação → Task 8. §5 paridade src×edge → Task 7. §6 restrições de entrega → Task 9. Os 13
sites afetados da §3.3: visit-score-recalc (T7), agenda (T5), escopo-clientes (T5), useTacticalPlan
(T5), ranking (T5), tactical-plans-batch (T7). Os 4 de `calculate-scores` são **PR 2**, fora deste
plano por decisão do founder.

**Consistência de tipos:** `potencialConhecido(raw: unknown): number | null` (T1) é usado com essa
assinatura em T5, T7, T8. `MissionResult { score, insumosAusentes }` (T2) é produzido em T3 e
consumido em T4, T6, T7. `VisitScore.insumos_ausentes` (T2) é preenchido em T4 e lido em T6.
`COLUNAS_SEM_PRODUTOR` (T8) é a fonte do gate no mesmo arquivo de teste.

**Nota de risco conhecida:** a Task 2 deixa o `typecheck` vermelho de propósito, e ele só fecha na
Task 5. O commit isolado da Task 2 é intencional (bisseção), mas **a série de commits 2→5 não deve
ser interrompida** — se a execução parar no meio, a branch fica sem compilar.
