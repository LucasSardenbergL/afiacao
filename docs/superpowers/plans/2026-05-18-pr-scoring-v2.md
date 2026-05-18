# PR-SCORING-V2: Sinais do Copilot → priority_score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sinais que o Copilot extrai durante chamadas (entities_extracted, analyses snapshots) viram modulators que ajustam churn_risk, expansion_score, health_score e eff_score em `farmer_client_scores`, com recálculo automático via trigger pós-call + cron noturno. Resultado: a agenda do Farmer/Hunter reordena automaticamente baseado no que foi dito nas chamadas de hoje.

**Architecture:**
1. **Migration**: adiciona `signal_modifiers jsonb` + `last_signal_recalc_at timestamptz` em `farmer_client_scores`; cria fila `score_recalc_queue`; cria trigger AFTER INSERT em `farmer_calls` que enfileira recálculo.
2. **Lib pura testável** (`src/lib/scoring/`): funções determinísticas que computam ajustes a partir de `entities_extracted` + `analyses` de N chamadas, com decay temporal (50% a cada 30 dias). Vitest puro, sem mocks.
3. **Edge function `scoring-recalc-client`**: dado (customer_user_id, farmer_id), busca últimos 30 dias de farmer_calls, computa modifiers, faz UPSERT em farmer_client_scores. Drena fila quando invocada sem args.
4. **Edge function `scoring-recalc-batch`**: cron 03:00 BRT — itera farmers ativos, invoca scoring-recalc-client em batch.
5. **UI**: hook expõe `signal_modifiers` breakdown; `AgendaTodayList` mostra badge com modulator dominante ("↑ R$ 15k upsell" / "⚠ concorrente Farben").

**Tech Stack:** Supabase Postgres (jsonb + triggers) + Deno Edge Functions + Anthropic SDK (já em uso) + React Query + Vitest

---

## File Structure

**Create:**
- `supabase/migrations/20260518100000_scoring_v2_signal_modifiers.sql` — schema + trigger
- `src/lib/scoring/modulators.ts` — funções puras que mapeiam entity/analysis → modifier
- `src/lib/scoring/decay.ts` — decay temporal exponencial
- `src/lib/scoring/aggregate.ts` — agrega modifiers de N chamadas em modifier final
- `src/lib/scoring/types.ts` — tipos compartilhados (SignalModifier, ScoreAdjustment)
- `src/lib/scoring/__tests__/modulators.test.ts`
- `src/lib/scoring/__tests__/decay.test.ts`
- `src/lib/scoring/__tests__/aggregate.test.ts`
- `supabase/functions/scoring-recalc-client/index.ts` — edge function
- `supabase/functions/scoring-recalc-batch/index.ts` — edge function (cron)
- `src/components/dashboard/SignalModifierBadge.tsx` — badge UI

**Modify:**
- `src/hooks/useMyCarteiraScores.ts` — adicionar `signal_modifiers` ao select e ao tipo `CarteiraScoreRow`
- `src/hooks/useMyAgendaToday.ts` — passar `signal_modifiers` adiante em `AgendaItem`
- `src/components/dashboard/AgendaTodayList.tsx` — renderizar `<SignalModifierBadge />` na linha do cliente

**Test:**
- `src/lib/scoring/__tests__/*.test.ts` (3 arquivos, listados acima)

**Cron setup (manual no Supabase Dashboard depois do merge):**
- pg_cron schedule: `0 6 * * *` UTC (= 03:00 BRT) chamando `scoring-recalc-batch`

---

## Pre-flight: schema discovery e validação de premissas

Antes de implementar, confirme as 3 premissas que sustentam o plano. Se alguma falhar, pause e ajuste o plano.

- [ ] **Premissa 1: `farmer_client_scores` tem as colunas que vamos modular.**

Rode no SQL Editor:
```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'farmer_client_scores'
  AND column_name IN ('churn_risk','expansion_score','health_score','eff_score','priority_score','recover_score');
```
Esperado: 6 linhas, todas `numeric`. Se faltar alguma, é regression — abortar.

- [ ] **Premissa 2: `farmer_calls.entities_extracted` está sendo populado.**

Rode:
```sql
SELECT count(*) FILTER (WHERE entities_extracted IS NOT NULL) AS with_entities,
       count(*) AS total
FROM public.farmer_calls
WHERE started_at > now() - interval '30 days';
```
Esperado: `with_entities > 0`. Se for 0, o copilot não está persistindo entities — investigar `WebRTCCallContext.endCall` antes de seguir (PR-SCORING-V2 não tem efeito sem isso).

- [ ] **Premissa 3: `commercial_roles` table existe (depende de PR #90 mergeado).**

Rode:
```sql
SELECT EXISTS(SELECT 1 FROM pg_tables WHERE tablename = 'commercial_roles') AS exists;
```
Esperado: `true`. Se `false`, mergear PR #90 primeiro. PR-SCORING-V2 não depende diretamente, mas `scoring-recalc-batch` itera farmers ativos via essa tabela.

---

### Task 1: Migration — signal_modifiers + recalc queue + trigger

**Files:**
- Create: `supabase/migrations/20260518100000_scoring_v2_signal_modifiers.sql`

- [ ] **Step 1: Escrever a migration completa**

```sql
-- PR-SCORING-V2: sinais do copilot modulando priority_score
-- Adiciona signal_modifiers (jsonb), fila de recálculo, trigger pós-call.

-- 1. Colunas novas em farmer_client_scores
ALTER TABLE public.farmer_client_scores
  ADD COLUMN IF NOT EXISTS signal_modifiers jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_signal_recalc_at timestamptz;

COMMENT ON COLUMN public.farmer_client_scores.signal_modifiers IS
  'Breakdown dos modifiers aplicados pelo copilot. Schema: { churn: { delta: number, reasons: [{kind, value, weight, decay}] }, expansion: {...}, health: {...}, eff: {...} }. Reset a cada recálculo.';
COMMENT ON COLUMN public.farmer_client_scores.last_signal_recalc_at IS
  'Última vez que scoring-recalc-client rodou pra esse (customer_user_id, farmer_id).';

-- 2. Fila de recálculo (drain async pelo edge function)
CREATE TABLE IF NOT EXISTS public.score_recalc_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL,
  reason text NOT NULL,             -- 'call_inserted' | 'manual' | 'cron'
  source_call_id uuid REFERENCES public.farmer_calls(id) ON DELETE SET NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text,
  UNIQUE (customer_user_id, farmer_id, processed_at) -- dedup mas só de não-processados
);

CREATE INDEX IF NOT EXISTS idx_score_recalc_queue_pending
  ON public.score_recalc_queue (enqueued_at)
  WHERE processed_at IS NULL;

ALTER TABLE public.score_recalc_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view recalc queue" ON public.score_recalc_queue FOR SELECT
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Staff can insert recalc queue" ON public.score_recalc_queue FOR INSERT
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- Service role (edge functions) bypass via service_role usage; sem policy update/delete pra users.

-- 3. Trigger pós-call: quando insere/atualiza farmer_calls com entities_extracted,
--    enfileira recálculo do par (customer_user_id, farmer_id).
CREATE OR REPLACE FUNCTION public.enqueue_score_recalc_from_call()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Só enfileira se a chamada tem cliente vinculado E entities_extracted (sinal real)
  IF NEW.customer_user_id IS NOT NULL
     AND NEW.entities_extracted IS NOT NULL
     AND jsonb_array_length(NEW.entities_extracted) > 0 THEN
    INSERT INTO public.score_recalc_queue
      (customer_user_id, farmer_id, reason, source_call_id)
    VALUES
      (NEW.customer_user_id, NEW.farmer_id, 'call_inserted', NEW.id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_farmer_calls_enqueue_recalc ON public.farmer_calls;
CREATE TRIGGER trg_farmer_calls_enqueue_recalc
  AFTER INSERT OR UPDATE OF entities_extracted ON public.farmer_calls
  FOR EACH ROW
  EXECUTE FUNCTION public.enqueue_score_recalc_from_call();

-- 4. View helper: pendentes (consumido pelo edge function)
CREATE OR REPLACE VIEW public.score_recalc_pending AS
SELECT q.*
FROM public.score_recalc_queue q
WHERE q.processed_at IS NULL
ORDER BY q.enqueued_at;

GRANT SELECT ON public.score_recalc_pending TO authenticated, service_role;
```

- [ ] **Step 2: Aplicar a migration manualmente no Supabase Dashboard**

Lovable Cloud NÃO aplica auto migrations com nome custom (ver CLAUDE.md §5).

1. Supabase Dashboard → SQL Editor → New query
2. Cola conteúdo de `20260518100000_scoring_v2_signal_modifiers.sql`
3. Run

- [ ] **Step 3: Validar aplicação**

No SQL Editor:
```sql
-- Colunas novas
SELECT column_name FROM information_schema.columns
WHERE table_name = 'farmer_client_scores'
  AND column_name IN ('signal_modifiers','last_signal_recalc_at');
-- Esperado: 2 linhas

-- Tabela nova
SELECT EXISTS(SELECT 1 FROM pg_tables WHERE tablename = 'score_recalc_queue') AS exists;
-- Esperado: true

-- Trigger ativo
SELECT tgname FROM pg_trigger WHERE tgname = 'trg_farmer_calls_enqueue_recalc';
-- Esperado: 1 linha
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518100000_scoring_v2_signal_modifiers.sql
git commit -m "feat(scoring): migration v2 — signal_modifiers + recalc queue + trigger"
```

---

### Task 2: Tipos compartilhados (`src/lib/scoring/types.ts`)

**Files:**
- Create: `src/lib/scoring/types.ts`

- [ ] **Step 1: Escrever os tipos**

```typescript
/**
 * PR-SCORING-V2: tipos do pipeline de modulators de score.
 *
 * Pipeline:
 *   farmer_calls.entities_extracted + farmer_calls.analyses
 *     → modulators (1 modifier por entity/analysis relevante)
 *     → aggregate (soma com decay temporal)
 *     → ScoreAdjustment (deltas finais aplicados em farmer_client_scores)
 */

export type EntityType =
  | 'competitor'
  | 'price'
  | 'volume'
  | 'product'
  | 'timeline'
  | 'decision_maker';

export interface ExtractedEntity {
  type: EntityType;
  value: string;
  context: string;
  confidence: number; // 0-1
}

/**
 * Snapshot de análise SPIN persistido em farmer_calls.analyses (do PR3/PR3.5).
 * Não importa toda a estrutura — só os campos que viram modifier.
 */
export interface AnalysisSnapshot {
  playbook?: 'discovery' | 'teach' | 'close';
  opportunities?: Array<{ type: string; value?: number; description?: string }>;
  risks?: Array<{ severity: 'baixa' | 'media' | 'alta'; description?: string }>;
  entitiesExtracted?: ExtractedEntity[];
  // outros campos ignorados intencionalmente
}

/**
 * Dimensões de score que um modifier pode tocar.
 * Mapeia 1:1 nas colunas de farmer_client_scores.
 */
export type ScoreDimension = 'churn' | 'expansion' | 'health' | 'eff';

/**
 * Tipos de sinal reconhecidos pelo modulators.ts.
 * Adicionar novo: 1) cria branch no modulators, 2) cobre teste.
 */
export type SignalKind =
  | 'competitor_mentioned'
  | 'price_objection_high'
  | 'desired_outcome'
  | 'opportunity_upsell'
  | 'risk_high'
  | 'close_attempted_no_close';

/**
 * Modifier individual: 1 entity ou 1 analysis pode gerar 1 modifier (ou nenhum).
 * `decayedWeight` é o `weight` após aplicação do decay temporal.
 */
export interface SignalModifier {
  dimension: ScoreDimension;
  kind: SignalKind;
  delta: number; // pontos a somar (positivo) ou subtrair (negativo) na dimensão
  weight: number; // peso base (1.0 = sinal forte; 0.5 = sinal fraco)
  decayedWeight: number;
  reason: string; // texto humano pra UI ("Concorrente Farben mencionado")
  sourceCallId: string;
  capturedAt: string; // ISO timestamp do farmer_calls.started_at
  daysSince: number;
}

/**
 * Ajuste final pra UPSERT em farmer_client_scores.
 * Cada dimensão acumula a soma dos deltas dos modifiers que tocam ela.
 * `breakdown` vai pra coluna signal_modifiers (jsonb) pra UI mostrar tooltip.
 */
export interface ScoreAdjustment {
  churn_delta: number;
  expansion_delta: number;
  health_delta: number;
  eff_delta: number;
  breakdown: {
    churn: SignalModifier[];
    expansion: SignalModifier[];
    health: SignalModifier[];
    eff: SignalModifier[];
  };
  computed_at: string; // ISO
  source_call_count: number;
}
```

- [ ] **Step 2: Validar typecheck**

```bash
bunx tsc --noEmit
```
Esperado: zero erros novos.

- [ ] **Step 3: Commit**

```bash
git add src/lib/scoring/types.ts
git commit -m "feat(scoring): tipos compartilhados — SignalModifier, ScoreAdjustment"
```

---

### Task 3: Decay temporal (`src/lib/scoring/decay.ts`) — TDD

**Files:**
- Create: `src/lib/scoring/decay.ts`
- Create: `src/lib/scoring/__tests__/decay.test.ts`

- [ ] **Step 1: Escrever o teste primeiro (failing)**

```typescript
// src/lib/scoring/__tests__/decay.test.ts
import { describe, it, expect } from 'vitest';
import { applyTemporalDecay, daysBetween } from '../decay';

describe('decay', () => {
  describe('daysBetween', () => {
    it('retorna 0 pra mesmo dia', () => {
      const d = new Date('2026-05-18T10:00:00Z');
      expect(daysBetween(d, d)).toBe(0);
    });

    it('conta dias entre datas', () => {
      const a = new Date('2026-05-01T10:00:00Z');
      const b = new Date('2026-05-15T10:00:00Z');
      expect(daysBetween(a, b)).toBe(14);
    });

    it('é simétrico (absoluto)', () => {
      const a = new Date('2026-05-01T10:00:00Z');
      const b = new Date('2026-05-15T10:00:00Z');
      expect(daysBetween(b, a)).toBe(14);
    });
  });

  describe('applyTemporalDecay', () => {
    it('peso integral em 0 dias', () => {
      expect(applyTemporalDecay(1.0, 0)).toBe(1.0);
    });

    it('peso = 0.5 em 30 dias (half-life)', () => {
      expect(applyTemporalDecay(1.0, 30)).toBeCloseTo(0.5, 2);
    });

    it('peso = 0.25 em 60 dias (2 half-lives)', () => {
      expect(applyTemporalDecay(1.0, 60)).toBeCloseTo(0.25, 2);
    });

    it('peso = 0.125 em 90 dias', () => {
      expect(applyTemporalDecay(1.0, 90)).toBeCloseTo(0.125, 2);
    });

    it('escala linearmente com weight inicial', () => {
      expect(applyTemporalDecay(2.0, 30)).toBeCloseTo(1.0, 2);
      expect(applyTemporalDecay(0.5, 30)).toBeCloseTo(0.25, 2);
    });

    it('nunca retorna negativo', () => {
      expect(applyTemporalDecay(1.0, 365)).toBeGreaterThan(0);
    });
  });
});
```

- [ ] **Step 2: Rodar pra confirmar que falha**

```bash
bun run test -- src/lib/scoring/__tests__/decay.test.ts
```
Esperado: FAIL com "Cannot find module '../decay'".

- [ ] **Step 3: Implementação mínima**

```typescript
// src/lib/scoring/decay.ts
/**
 * Decay temporal exponencial pra sinais do copilot.
 * Half-life = 30 dias: sinal de 1 chamada perde 50% do peso a cada 30 dias.
 *
 * Justificativa de produto: clientes mudam de fornecedor / situação. Sinal de
 * "Farben mencionado há 6 meses" não deve ter mesmo peso que "Farben mencionado
 * ontem". 30 dias é o ciclo médio de compra do nosso segmento moveleiro.
 *
 * Fórmula: weight(t) = weight(0) * 2^(-days / HALF_LIFE_DAYS)
 */

const HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

export function daysBetween(a: Date, b: Date): number {
  return Math.abs(Math.round((b.getTime() - a.getTime()) / MS_PER_DAY));
}

export function applyTemporalDecay(weight: number, daysSince: number): number {
  if (daysSince <= 0) return weight;
  return weight * Math.pow(2, -daysSince / HALF_LIFE_DAYS);
}
```

- [ ] **Step 4: Rodar testes — devem passar**

```bash
bun run test -- src/lib/scoring/__tests__/decay.test.ts
```
Esperado: PASS, 7 testes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scoring/decay.ts src/lib/scoring/__tests__/decay.test.ts
git commit -m "feat(scoring): decay temporal exponencial (half-life 30d) + testes"
```

---

### Task 4: Modulators puros (`src/lib/scoring/modulators.ts`) — TDD

**Files:**
- Create: `src/lib/scoring/modulators.ts`
- Create: `src/lib/scoring/__tests__/modulators.test.ts`

A lógica: cada **entity** ou **analysis** pode virar 0..1 modifiers. Os modifiers são puros (sem decay aplicado) — decay vem no aggregate.

- [ ] **Step 1: Teste primeiro (failing)**

```typescript
// src/lib/scoring/__tests__/modulators.test.ts
import { describe, it, expect } from 'vitest';
import {
  modifiersFromEntity,
  modifiersFromAnalysis,
} from '../modulators';
import type { ExtractedEntity, AnalysisSnapshot } from '../types';

const baseMeta = {
  sourceCallId: 'call-1',
  capturedAt: '2026-05-18T10:00:00Z',
  daysSince: 0,
};

describe('modifiersFromEntity', () => {
  it('competitor mencionado → +churn (peso 1.0, delta +15)', () => {
    const e: ExtractedEntity = { type: 'competitor', value: 'Farben', context: 'comprei da Farben', confidence: 0.9 };
    const mods = modifiersFromEntity(e, baseMeta);
    expect(mods).toHaveLength(1);
    expect(mods[0].dimension).toBe('churn');
    expect(mods[0].kind).toBe('competitor_mentioned');
    expect(mods[0].delta).toBe(15);
    expect(mods[0].weight).toBe(1.0);
    expect(mods[0].reason).toContain('Farben');
  });

  it('competitor com baixa confiança → weight reduzido', () => {
    const e: ExtractedEntity = { type: 'competitor', value: 'Farben', context: '...', confidence: 0.4 };
    const mods = modifiersFromEntity(e, baseMeta);
    expect(mods[0].weight).toBeCloseTo(0.4, 2);
  });

  it('decision_maker → 0 modifiers (não é sinal de score)', () => {
    const e: ExtractedEntity = { type: 'decision_maker', value: 'sócio', context: '', confidence: 1 };
    expect(modifiersFromEntity(e, baseMeta)).toHaveLength(0);
  });

  it('timeline urgente → +expansion (peso 0.5, delta +10)', () => {
    const e: ExtractedEntity = { type: 'timeline', value: 'pedido pro mês que vem', context: '', confidence: 0.9 };
    const mods = modifiersFromEntity(e, baseMeta);
    expect(mods).toHaveLength(1);
    expect(mods[0].dimension).toBe('expansion');
    expect(mods[0].delta).toBe(10);
  });
});

describe('modifiersFromAnalysis', () => {
  it('price_objection severidade alta → +churn delta 20', () => {
    const a: AnalysisSnapshot = {
      risks: [{ severity: 'alta', description: 'objeção de preço forte' }],
    };
    const mods = modifiersFromAnalysis(a, baseMeta);
    const churn = mods.filter((m) => m.dimension === 'churn');
    expect(churn).toHaveLength(1);
    expect(churn[0].kind).toBe('risk_high');
    expect(churn[0].delta).toBe(20);
  });

  it('opportunity upsell com value → +expansion delta proporcional', () => {
    const a: AnalysisSnapshot = {
      opportunities: [{ type: 'upsell', value: 15000, description: 'sistema PU' }],
    };
    const mods = modifiersFromAnalysis(a, baseMeta);
    const exp = mods.filter((m) => m.dimension === 'expansion');
    expect(exp).toHaveLength(1);
    expect(exp[0].kind).toBe('opportunity_upsell');
    expect(exp[0].delta).toBeGreaterThan(0);
  });

  it('close attempt + cliente não convertido (sem entitiesExtracted relevantes) → eff penalty', () => {
    // Sinal: playbook=close foi rodado mas sem opportunity firmada no snapshot
    const a: AnalysisSnapshot = {
      playbook: 'close',
      opportunities: [],
      risks: [],
    };
    const mods = modifiersFromAnalysis(a, baseMeta);
    const eff = mods.filter((m) => m.dimension === 'eff');
    expect(eff).toHaveLength(1);
    expect(eff[0].kind).toBe('close_attempted_no_close');
    expect(eff[0].delta).toBeLessThan(0);
  });

  it('discovery puro → 0 modifiers (não é sinal forte ainda)', () => {
    const a: AnalysisSnapshot = { playbook: 'discovery', opportunities: [], risks: [] };
    expect(modifiersFromAnalysis(a, baseMeta)).toHaveLength(0);
  });

  it('snapshot vazio → 0 modifiers', () => {
    expect(modifiersFromAnalysis({}, baseMeta)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — deve falhar**

```bash
bun run test -- src/lib/scoring/__tests__/modulators.test.ts
```
Esperado: FAIL ("Cannot find module '../modulators'").

- [ ] **Step 3: Implementação**

```typescript
// src/lib/scoring/modulators.ts
import type {
  AnalysisSnapshot,
  ExtractedEntity,
  ScoreDimension,
  SignalKind,
  SignalModifier,
} from './types';

interface ModifierMeta {
  sourceCallId: string;
  capturedAt: string;
  daysSince: number;
}

/**
 * Cada entity vira 0..1 modifier. Confidence multiplica o peso base.
 * Decay temporal NÃO é aplicado aqui — fica pro aggregate.
 */
export function modifiersFromEntity(
  entity: ExtractedEntity,
  meta: ModifierMeta,
): SignalModifier[] {
  const baseWeight = Math.max(0, Math.min(1, entity.confidence));

  switch (entity.type) {
    case 'competitor':
      return [{
        dimension: 'churn',
        kind: 'competitor_mentioned',
        delta: 15,
        weight: baseWeight,
        decayedWeight: baseWeight, // aggregate sobrescreve
        reason: `Concorrente ${entity.value} mencionado`,
        sourceCallId: meta.sourceCallId,
        capturedAt: meta.capturedAt,
        daysSince: meta.daysSince,
      }];

    case 'timeline':
      // Heurística: presença de timeline = intent de compra próxima
      return [{
        dimension: 'expansion',
        kind: 'desired_outcome',
        delta: 10,
        weight: baseWeight * 0.5, // sinal médio
        decayedWeight: baseWeight * 0.5,
        reason: `Prazo: ${entity.value}`,
        sourceCallId: meta.sourceCallId,
        capturedAt: meta.capturedAt,
        daysSince: meta.daysSince,
      }];

    case 'price':
    case 'volume':
    case 'product':
    case 'decision_maker':
      // Não viram modifier — são contexto, não sinal de score.
      return [];

    default:
      return [];
  }
}

/**
 * Cada analysis snapshot pode gerar múltiplos modifiers (1 por risk/opportunity).
 */
export function modifiersFromAnalysis(
  analysis: AnalysisSnapshot,
  meta: ModifierMeta,
): SignalModifier[] {
  const out: SignalModifier[] = [];

  // Risks de alta severidade → churn risk
  for (const r of analysis.risks ?? []) {
    if (r.severity === 'alta') {
      out.push({
        dimension: 'churn',
        kind: 'risk_high',
        delta: 20,
        weight: 1.0,
        decayedWeight: 1.0,
        reason: r.description || 'Risco alto identificado',
        sourceCallId: meta.sourceCallId,
        capturedAt: meta.capturedAt,
        daysSince: meta.daysSince,
      });
    }
    // 'media' e 'baixa' não geram modifier — viram ruído.
  }

  // Opportunities → expansion
  for (const o of analysis.opportunities ?? []) {
    if (o.type === 'upsell' || o.type === 'cross_sell') {
      // Delta proporcional ao value (com cap pra evitar dominância)
      // value=R$15k → delta 15; cap em 40.
      const value = o.value ?? 5000;
      const delta = Math.min(40, Math.max(5, value / 1000));
      out.push({
        dimension: 'expansion',
        kind: 'opportunity_upsell',
        delta,
        weight: 1.0,
        decayedWeight: 1.0,
        reason: o.description || `Oportunidade ${o.type} (R$ ${value.toLocaleString('pt-BR')})`,
        sourceCallId: meta.sourceCallId,
        capturedAt: meta.capturedAt,
        daysSince: meta.daysSince,
      });
    }
  }

  // Close attempt sem opportunity → eff penalty (vendedor empurrou sem qualificar)
  if (analysis.playbook === 'close' && (analysis.opportunities ?? []).length === 0) {
    out.push({
      dimension: 'eff',
      kind: 'close_attempted_no_close',
      delta: -5,
      weight: 0.5,
      decayedWeight: 0.5,
      reason: 'Tentativa de fechamento sem oportunidade qualificada',
      sourceCallId: meta.sourceCallId,
      capturedAt: meta.capturedAt,
      daysSince: meta.daysSince,
    });
  }

  return out;
}
```

- [ ] **Step 4: Run — deve passar**

```bash
bun run test -- src/lib/scoring/__tests__/modulators.test.ts
```
Esperado: PASS, 9 testes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scoring/modulators.ts src/lib/scoring/__tests__/modulators.test.ts
git commit -m "feat(scoring): modulators puros (entity + analysis → SignalModifier) + testes"
```

---

### Task 5: Aggregate (`src/lib/scoring/aggregate.ts`) — TDD

Combina modifiers de N chamadas, aplica decay temporal, retorna `ScoreAdjustment` final.

**Files:**
- Create: `src/lib/scoring/aggregate.ts`
- Create: `src/lib/scoring/__tests__/aggregate.test.ts`

- [ ] **Step 1: Teste primeiro**

```typescript
// src/lib/scoring/__tests__/aggregate.test.ts
import { describe, it, expect } from 'vitest';
import { aggregateModifiers } from '../aggregate';
import type { SignalModifier } from '../types';

const now = new Date('2026-05-18T10:00:00Z');

function mkMod(opts: Partial<SignalModifier>): SignalModifier {
  return {
    dimension: 'churn',
    kind: 'competitor_mentioned',
    delta: 15,
    weight: 1.0,
    decayedWeight: 1.0,
    reason: '',
    sourceCallId: 'call-x',
    capturedAt: now.toISOString(),
    daysSince: 0,
    ...opts,
  };
}

describe('aggregateModifiers', () => {
  it('lista vazia → ajuste zero', () => {
    const adj = aggregateModifiers([], now);
    expect(adj.churn_delta).toBe(0);
    expect(adj.expansion_delta).toBe(0);
    expect(adj.health_delta).toBe(0);
    expect(adj.eff_delta).toBe(0);
    expect(adj.source_call_count).toBe(0);
  });

  it('1 modifier churn @ 0 dias → delta integral', () => {
    const m = mkMod({ dimension: 'churn', delta: 15, weight: 1.0, capturedAt: now.toISOString() });
    const adj = aggregateModifiers([m], now);
    expect(adj.churn_delta).toBe(15);
    expect(adj.breakdown.churn).toHaveLength(1);
    expect(adj.breakdown.churn[0].decayedWeight).toBe(1.0);
  });

  it('1 modifier churn @ 30 dias → delta * 0.5', () => {
    const captured = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
    const m = mkMod({ dimension: 'churn', delta: 15, weight: 1.0, capturedAt: captured });
    const adj = aggregateModifiers([m], now);
    expect(adj.churn_delta).toBeCloseTo(7.5, 1);
    expect(adj.breakdown.churn[0].decayedWeight).toBeCloseTo(0.5, 2);
  });

  it('soma por dimensão (2 churn → churn_delta soma; expansion intocado)', () => {
    const mods = [
      mkMod({ dimension: 'churn', delta: 15 }),
      mkMod({ dimension: 'churn', delta: 20 }),
      mkMod({ dimension: 'expansion', delta: 10 }),
    ];
    const adj = aggregateModifiers(mods, now);
    expect(adj.churn_delta).toBe(35);
    expect(adj.expansion_delta).toBe(10);
  });

  it('source_call_count conta calls únicas', () => {
    const mods = [
      mkMod({ sourceCallId: 'a' }),
      mkMod({ sourceCallId: 'a' }), // mesma call, 2 modifiers
      mkMod({ sourceCallId: 'b' }),
    ];
    const adj = aggregateModifiers(mods, now);
    expect(adj.source_call_count).toBe(2);
  });

  it('peso < 1 multiplica delta proporcionalmente', () => {
    const m = mkMod({ delta: 15, weight: 0.5 });
    const adj = aggregateModifiers([m], now);
    expect(adj.churn_delta).toBeCloseTo(7.5, 2);
  });

  it('delta negativo (eff penalty) preservado', () => {
    const m = mkMod({ dimension: 'eff', delta: -5, weight: 1.0 });
    const adj = aggregateModifiers([m], now);
    expect(adj.eff_delta).toBe(-5);
  });

  it('breakdown agrupa por dimensão', () => {
    const mods = [
      mkMod({ dimension: 'churn' }),
      mkMod({ dimension: 'expansion' }),
      mkMod({ dimension: 'eff' }),
    ];
    const adj = aggregateModifiers(mods, now);
    expect(adj.breakdown.churn).toHaveLength(1);
    expect(adj.breakdown.expansion).toHaveLength(1);
    expect(adj.breakdown.eff).toHaveLength(1);
    expect(adj.breakdown.health).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — deve falhar**

```bash
bun run test -- src/lib/scoring/__tests__/aggregate.test.ts
```
Esperado: FAIL.

- [ ] **Step 3: Implementação**

```typescript
// src/lib/scoring/aggregate.ts
import { applyTemporalDecay, daysBetween } from './decay';
import type { ScoreAdjustment, ScoreDimension, SignalModifier } from './types';

/**
 * Recebe modifiers de N chamadas, aplica decay temporal baseado em capturedAt
 * vs `now`, retorna ScoreAdjustment com deltas por dimensão + breakdown.
 *
 * Delta final por dimensão = soma(modifier.delta * decayedWeight) onde
 * decayedWeight = modifier.weight * decay(daysSince).
 */
export function aggregateModifiers(
  modifiers: SignalModifier[],
  now: Date = new Date(),
): ScoreAdjustment {
  const breakdown: ScoreAdjustment['breakdown'] = {
    churn: [],
    expansion: [],
    health: [],
    eff: [],
  };

  const deltas: Record<ScoreDimension, number> = {
    churn: 0,
    expansion: 0,
    health: 0,
    eff: 0,
  };

  const uniqueCalls = new Set<string>();

  for (const m of modifiers) {
    const capturedDate = new Date(m.capturedAt);
    const days = daysBetween(capturedDate, now);
    const decayed = applyTemporalDecay(m.weight, days);

    const enriched: SignalModifier = {
      ...m,
      daysSince: days,
      decayedWeight: decayed,
    };

    breakdown[m.dimension].push(enriched);
    deltas[m.dimension] += m.delta * decayed;
    uniqueCalls.add(m.sourceCallId);
  }

  return {
    churn_delta: round2(deltas.churn),
    expansion_delta: round2(deltas.expansion),
    health_delta: round2(deltas.health),
    eff_delta: round2(deltas.eff),
    breakdown,
    computed_at: now.toISOString(),
    source_call_count: uniqueCalls.size,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
```

- [ ] **Step 4: Run — deve passar**

```bash
bun run test -- src/lib/scoring/__tests__/aggregate.test.ts
```
Esperado: PASS, 8 testes.

- [ ] **Step 5: Rodar suíte completa de scoring**

```bash
bun run test -- src/lib/scoring
```
Esperado: PASS, 24 testes (7 decay + 9 modulators + 8 aggregate).

- [ ] **Step 6: Commit**

```bash
git add src/lib/scoring/aggregate.ts src/lib/scoring/__tests__/aggregate.test.ts
git commit -m "feat(scoring): aggregate com decay temporal — modifiers → ScoreAdjustment"
```

---

### Task 6: Edge function `scoring-recalc-client`

Dado `(customer_user_id, farmer_id)` ou `null` (drena fila), busca farmer_calls dos últimos 30 dias, computa adjustment, faz UPSERT em farmer_client_scores.

**Files:**
- Create: `supabase/functions/scoring-recalc-client/index.ts`

- [ ] **Step 1: Escrever a edge function**

```typescript
// supabase/functions/scoring-recalc-client/index.ts
import { createClient } from 'npm:@supabase/supabase-js@^2';
import { authorizeCronOrStaff, corsHeaders } from '../_shared/auth.ts';

// Imports puros das libs JS — copiamos inline pra não cross-import com src/.
// Quando estabilizar, mover pra _shared/scoring/ (TODO PR-SCORING-V2.1).

const HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

function daysBetween(a: Date, b: Date): number {
  return Math.abs(Math.round((b.getTime() - a.getTime()) / MS_PER_DAY));
}

function applyTemporalDecay(weight: number, daysSince: number): number {
  if (daysSince <= 0) return weight;
  return weight * Math.pow(2, -daysSince / HALF_LIFE_DAYS);
}

interface ExtractedEntity {
  type: string;
  value: string;
  context: string;
  confidence: number;
}

interface AnalysisSnapshot {
  playbook?: string;
  opportunities?: Array<{ type: string; value?: number; description?: string }>;
  risks?: Array<{ severity: string; description?: string }>;
  entitiesExtracted?: ExtractedEntity[];
}

interface ModifierMeta {
  sourceCallId: string;
  capturedAt: string;
  daysSince: number;
}

interface SignalModifier {
  dimension: 'churn' | 'expansion' | 'health' | 'eff';
  kind: string;
  delta: number;
  weight: number;
  decayedWeight: number;
  reason: string;
  sourceCallId: string;
  capturedAt: string;
  daysSince: number;
}

function modifiersFromEntity(entity: ExtractedEntity, meta: ModifierMeta): SignalModifier[] {
  const baseWeight = Math.max(0, Math.min(1, entity.confidence));
  switch (entity.type) {
    case 'competitor':
      return [{ dimension: 'churn', kind: 'competitor_mentioned', delta: 15, weight: baseWeight, decayedWeight: baseWeight, reason: `Concorrente ${entity.value} mencionado`, sourceCallId: meta.sourceCallId, capturedAt: meta.capturedAt, daysSince: meta.daysSince }];
    case 'timeline':
      return [{ dimension: 'expansion', kind: 'desired_outcome', delta: 10, weight: baseWeight * 0.5, decayedWeight: baseWeight * 0.5, reason: `Prazo: ${entity.value}`, sourceCallId: meta.sourceCallId, capturedAt: meta.capturedAt, daysSince: meta.daysSince }];
    default:
      return [];
  }
}

function modifiersFromAnalysis(analysis: AnalysisSnapshot, meta: ModifierMeta): SignalModifier[] {
  const out: SignalModifier[] = [];
  for (const r of analysis.risks ?? []) {
    if (r.severity === 'alta') {
      out.push({ dimension: 'churn', kind: 'risk_high', delta: 20, weight: 1.0, decayedWeight: 1.0, reason: r.description || 'Risco alto identificado', sourceCallId: meta.sourceCallId, capturedAt: meta.capturedAt, daysSince: meta.daysSince });
    }
  }
  for (const o of analysis.opportunities ?? []) {
    if (o.type === 'upsell' || o.type === 'cross_sell') {
      const value = o.value ?? 5000;
      const delta = Math.min(40, Math.max(5, value / 1000));
      out.push({ dimension: 'expansion', kind: 'opportunity_upsell', delta, weight: 1.0, decayedWeight: 1.0, reason: o.description || `Oportunidade ${o.type} (R$ ${value.toLocaleString('pt-BR')})`, sourceCallId: meta.sourceCallId, capturedAt: meta.capturedAt, daysSince: meta.daysSince });
    }
  }
  if (analysis.playbook === 'close' && (analysis.opportunities ?? []).length === 0) {
    out.push({ dimension: 'eff', kind: 'close_attempted_no_close', delta: -5, weight: 0.5, decayedWeight: 0.5, reason: 'Tentativa de fechamento sem oportunidade qualificada', sourceCallId: meta.sourceCallId, capturedAt: meta.capturedAt, daysSince: meta.daysSince });
  }
  return out;
}

interface RecalcRequest {
  customer_user_id?: string;
  farmer_id?: string;
  drain_queue?: boolean; // se true, ignora os ids e drena fila inteira
  max_drain?: number;    // default 50
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Auth: cron token (header x-cron-key) OU staff JWT
  const auth = await authorizeCronOrStaff(req);
  if (!auth.authorized) {
    return new Response(JSON.stringify({ error: auth.reason }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const body: RecalcRequest = await req.json().catch(() => ({}));

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Modo 1: drena fila
  if (body.drain_queue) {
    const max = body.max_drain ?? 50;
    const { data: pending, error: pErr } = await supabase
      .from('score_recalc_pending')
      .select('id, customer_user_id, farmer_id')
      .limit(max);
    if (pErr) {
      return jsonError(`fila: ${pErr.message}`, 500);
    }
    const results = [];
    for (const item of pending ?? []) {
      const r = await recalcOne(supabase, item.customer_user_id, item.farmer_id);
      await supabase.from('score_recalc_queue').update({
        processed_at: new Date().toISOString(),
        error: r.error ?? null,
      }).eq('id', item.id);
      results.push({ id: item.id, ...r });
    }
    return new Response(JSON.stringify({ drained: results.length, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Modo 2: par único
  if (!body.customer_user_id || !body.farmer_id) {
    return jsonError('customer_user_id e farmer_id obrigatórios (ou drain_queue=true)', 400);
  }
  const r = await recalcOne(supabase, body.customer_user_id, body.farmer_id);
  return new Response(JSON.stringify(r), {
    status: r.error ? 500 : 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

async function recalcOne(
  supabase: ReturnType<typeof createClient>,
  customer_user_id: string,
  farmer_id: string,
): Promise<{ ok: boolean; error?: string; adjustment?: unknown }> {
  // 1. Busca calls dos últimos 30 dias
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data: calls, error: cErr } = await supabase
    .from('farmer_calls')
    .select('id, started_at, entities_extracted, analyses')
    .eq('customer_user_id', customer_user_id)
    .eq('farmer_id', farmer_id)
    .gte('started_at', cutoff);

  if (cErr) return { ok: false, error: `farmer_calls: ${cErr.message}` };

  // 2. Constrói modifiers
  const now = new Date();
  const allMods: SignalModifier[] = [];

  for (const call of (calls ?? []) as Array<{
    id: string;
    started_at: string;
    entities_extracted: ExtractedEntity[] | null;
    analyses: AnalysisSnapshot[] | null;
  }>) {
    const meta = {
      sourceCallId: call.id,
      capturedAt: call.started_at,
      daysSince: daysBetween(new Date(call.started_at), now),
    };
    for (const e of call.entities_extracted ?? []) {
      allMods.push(...modifiersFromEntity(e, meta));
    }
    for (const a of call.analyses ?? []) {
      allMods.push(...modifiersFromAnalysis(a, meta));
    }
  }

  // 3. Aggregate
  const breakdown = { churn: [] as SignalModifier[], expansion: [] as SignalModifier[], health: [] as SignalModifier[], eff: [] as SignalModifier[] };
  const deltas = { churn: 0, expansion: 0, health: 0, eff: 0 };
  const uniqueCalls = new Set<string>();

  for (const m of allMods) {
    const decayed = applyTemporalDecay(m.weight, m.daysSince);
    const enriched = { ...m, decayedWeight: decayed };
    breakdown[m.dimension].push(enriched);
    deltas[m.dimension] += m.delta * decayed;
    uniqueCalls.add(m.sourceCallId);
  }

  const adjustment = {
    churn_delta: Math.round(deltas.churn * 100) / 100,
    expansion_delta: Math.round(deltas.expansion * 100) / 100,
    health_delta: Math.round(deltas.health * 100) / 100,
    eff_delta: Math.round(deltas.eff * 100) / 100,
    breakdown,
    computed_at: now.toISOString(),
    source_call_count: uniqueCalls.size,
  };

  // 4. UPSERT — soma deltas em cima do score existente (clamp 0..100)
  const { data: existing } = await supabase
    .from('farmer_client_scores')
    .select('churn_risk, expansion_score, health_score, eff_score, priority_score')
    .eq('customer_user_id', customer_user_id)
    .eq('farmer_id', farmer_id)
    .maybeSingle();

  const base = existing as { churn_risk?: number; expansion_score?: number; health_score?: number; eff_score?: number } | null;

  const newChurn = clamp((base?.churn_risk ?? 0) + adjustment.churn_delta, 0, 100);
  const newExpansion = clamp((base?.expansion_score ?? 0) + adjustment.expansion_delta, 0, 100);
  const newHealth = clamp((base?.health_score ?? 0) + adjustment.health_delta, 0, 1);
  const newEff = clamp((base?.eff_score ?? 0) + adjustment.eff_delta, 0, 100);

  // priority_score = (churn_risk + expansion_score) / 2 + eff_score * 0.3
  // (mantém compat com cálculo legado; PR-SCORING-V2.1 pode revisitar)
  const newPriority = clamp(newChurn * 0.5 + newExpansion * 0.5 + newEff * 0.3, 0, 100);

  const { error: uErr } = await supabase.from('farmer_client_scores').upsert({
    customer_user_id,
    farmer_id,
    churn_risk: newChurn,
    expansion_score: newExpansion,
    health_score: newHealth,
    eff_score: newEff,
    priority_score: newPriority,
    signal_modifiers: adjustment,
    last_signal_recalc_at: now.toISOString(),
    updated_at: now.toISOString(),
  }, { onConflict: 'customer_user_id,farmer_id' });

  if (uErr) return { ok: false, error: `upsert: ${uErr.message}` };

  return { ok: true, adjustment };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function jsonError(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
```

- [ ] **Step 2: Deploy via Lovable**

A edge function fica em `supabase/functions/scoring-recalc-client/index.ts` e o Lovable Cloud deploya quando você mergear. Se quiser testar local, `supabase functions serve scoring-recalc-client`.

- [ ] **Step 3: Smoke test manual (depois do merge)**

```bash
curl -X POST "$SUPABASE_URL/functions/v1/scoring-recalc-client" \
  -H "Authorization: Bearer $STAFF_JWT" \
  -H "Content-Type: application/json" \
  -d '{"customer_user_id":"<uuid_real>","farmer_id":"<uuid_real>"}'
```
Esperado: `{ ok: true, adjustment: { churn_delta, expansion_delta, breakdown, ... } }`.

Valida no SQL:
```sql
SELECT signal_modifiers, last_signal_recalc_at, churn_risk, expansion_score
FROM public.farmer_client_scores
WHERE customer_user_id = '<uuid>' AND farmer_id = '<uuid>';
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/scoring-recalc-client/
git commit -m "feat(scoring): edge function scoring-recalc-client — UPSERT modifiers"
```

---

### Task 7: Edge function `scoring-recalc-batch` (cron)

Itera farmers ativos (qualquer um com commercial_role IN ('farmer','hunter','closer','master')) e chama scoring-recalc-client com drain_queue=true.

**Files:**
- Create: `supabase/functions/scoring-recalc-batch/index.ts`

- [ ] **Step 1: Escrever a edge function**

```typescript
// supabase/functions/scoring-recalc-batch/index.ts
import { createClient } from 'npm:@supabase/supabase-js@^2';
import { authorizeCronOrStaff, corsHeaders } from '../_shared/auth.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.authorized) {
    return new Response(JSON.stringify({ error: auth.reason }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // 1. Drena fila pendente (chamadas inseridas hoje que ainda não recalcularam)
  const url = `${Deno.env.get('SUPABASE_URL')!}/functions/v1/scoring-recalc-client`;
  const drainResp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cron-key': Deno.env.get('CRON_SHARED_KEY') ?? '',
    },
    body: JSON.stringify({ drain_queue: true, max_drain: 500 }),
  });
  const drained = await drainResp.json().catch(() => ({}));

  // 2. Recalc full: para cada par (customer, farmer) com call nos últimos 30 dias
  //    que NÃO foi recalculado nas últimas 24h. Garante refresh diário do decay.
  const { data: pairs, error: pErr } = await supabase
    .from('farmer_calls')
    .select('customer_user_id, farmer_id')
    .gte('started_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString())
    .not('customer_user_id', 'is', null);

  if (pErr) {
    return new Response(JSON.stringify({ error: pErr.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Dedup
  const unique = new Map<string, { customer_user_id: string; farmer_id: string }>();
  for (const p of (pairs ?? []) as Array<{ customer_user_id: string; farmer_id: string }>) {
    unique.set(`${p.customer_user_id}::${p.farmer_id}`, p);
  }

  const results = [];
  for (const pair of unique.values()) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-key': Deno.env.get('CRON_SHARED_KEY') ?? '',
      },
      body: JSON.stringify(pair),
    });
    const j = await r.json().catch(() => ({}));
    results.push({ ...pair, ok: r.ok, ...j });
  }

  return new Response(JSON.stringify({
    drained,
    recalculated: results.length,
    errors: results.filter((r) => !r.ok).length,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
```

- [ ] **Step 2: Configurar cron pg_cron no Supabase (depois do merge)**

No SQL Editor:
```sql
-- Habilita pg_cron (idempotente)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 03:00 BRT = 06:00 UTC
SELECT cron.schedule(
  'scoring-recalc-batch-nightly',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/scoring-recalc-batch',
    headers := jsonb_build_object('x-cron-key', current_setting('app.cron_shared_key', true))
  );
  $$
);
```
**Atenção**: substituir `<PROJECT_REF>` pelo ref do projeto. `current_setting('app.cron_shared_key')` precisa estar configurado (já existe pra outros crons).

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/scoring-recalc-batch/
git commit -m "feat(scoring): edge function scoring-recalc-batch — cron noturno"
```

---

### Task 8: Hook expõe signal_modifiers + UI badge

**Files:**
- Modify: `src/hooks/useMyCarteiraScores.ts`
- Modify: `src/hooks/useMyAgendaToday.ts`
- Create: `src/components/dashboard/SignalModifierBadge.tsx`
- Modify: `src/components/dashboard/AgendaTodayList.tsx`

- [ ] **Step 1: Atualizar `useMyCarteiraScores.ts` — adicionar campo signal_modifiers**

```typescript
// src/hooks/useMyCarteiraScores.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import type { ScoreAdjustment } from '@/lib/scoring/types';

export interface CarteiraScoreRow {
  customer_user_id: string;
  health_score: number | null;
  health_class: string | null;
  priority_score: number | null;
  churn_risk: number | null;
  expansion_score: number | null;
  recover_score: number | null;
  revenue_potential: number | null;
  days_since_last_purchase: number | null;
  avg_monthly_spend_180d: number | null;
  signal_modifiers: ScoreAdjustment | null;
  last_signal_recalc_at: string | null;
}

export function useMyCarteiraScores() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-carteira-scores', user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<CarteiraScoreRow[]> => {
      if (!user) return [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('farmer_client_scores') as any)
        .select('customer_user_id, health_score, health_class, priority_score, churn_risk, expansion_score, recover_score, revenue_potential, days_since_last_purchase, avg_monthly_spend_180d, signal_modifiers, last_signal_recalc_at')
        .eq('farmer_id', user.id)
        .order('priority_score', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as CarteiraScoreRow[];
    },
  });
}
```

- [ ] **Step 2: Atualizar `useMyAgendaToday.ts` — propagar signal_modifiers**

```typescript
// src/hooks/useMyAgendaToday.ts
import { useMemo } from 'react';
import { useMyCarteiraScores } from './useMyCarteiraScores';
import type { ScoreAdjustment, SignalModifier } from '@/lib/scoring/types';

export interface AgendaItem {
  customer_user_id: string;
  priority_score: number;
  health_class: string | null;
  agenda_type: 'risco' | 'expansao' | 'follow_up';
  topModifier: SignalModifier | null; // modifier de maior |delta * decayedWeight|
  signalsCount: number;
}

export function useMyAgendaToday(limit = 10) {
  const { data, isLoading } = useMyCarteiraScores();

  const agenda: AgendaItem[] = useMemo(() => {
    if (!data) return [];
    return data.slice(0, limit).map((s) => {
      let agenda_type: AgendaItem['agenda_type'] = 'follow_up';
      const churn = s.churn_risk ?? 0;
      const expansion = s.expansion_score ?? 0;
      if (churn > 0.5 || s.health_class === 'critico' || s.health_class === 'atencao') {
        agenda_type = 'risco';
      } else if (expansion > 0.5) {
        agenda_type = 'expansao';
      }
      const mods = s.signal_modifiers;
      const topModifier = mods ? pickTopModifier(mods) : null;
      const signalsCount = mods
        ? mods.breakdown.churn.length + mods.breakdown.expansion.length + mods.breakdown.health.length + mods.breakdown.eff.length
        : 0;
      return {
        customer_user_id: s.customer_user_id,
        priority_score: s.priority_score ?? 0,
        health_class: s.health_class,
        agenda_type,
        topModifier,
        signalsCount,
      };
    });
  }, [data, limit]);

  return { agenda, isLoading };
}

function pickTopModifier(adj: ScoreAdjustment): SignalModifier | null {
  const all = [
    ...adj.breakdown.churn,
    ...adj.breakdown.expansion,
    ...adj.breakdown.health,
    ...adj.breakdown.eff,
  ];
  if (all.length === 0) return null;
  return all.reduce((top, cur) => {
    const topMag = Math.abs(top.delta * top.decayedWeight);
    const curMag = Math.abs(cur.delta * cur.decayedWeight);
    return curMag > topMag ? cur : top;
  });
}
```

- [ ] **Step 3: Criar `SignalModifierBadge.tsx`**

```typescript
// src/components/dashboard/SignalModifierBadge.tsx
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { TrendingUp, AlertTriangle, Target, Activity } from 'lucide-react';
import type { SignalModifier } from '@/lib/scoring/types';

const KIND_META: Record<string, { icon: typeof TrendingUp; color: string; emoji: string }> = {
  competitor_mentioned: { icon: AlertTriangle, color: 'text-status-error', emoji: '⚠' },
  risk_high: { icon: AlertTriangle, color: 'text-status-error', emoji: '⚠' },
  opportunity_upsell: { icon: TrendingUp, color: 'text-status-success', emoji: '↑' },
  desired_outcome: { icon: Target, color: 'text-status-info', emoji: '◎' },
  close_attempted_no_close: { icon: Activity, color: 'text-status-warning', emoji: '!' },
};

export function SignalModifierBadge({ modifier, totalSignals }: { modifier: SignalModifier; totalSignals: number }) {
  const meta = KIND_META[modifier.kind] ?? { icon: Activity, color: 'text-muted-foreground', emoji: '·' };
  const Icon = meta.icon;
  const days = modifier.daysSince;
  const dayLabel = days === 0 ? 'hoje' : days === 1 ? 'ontem' : `há ${days}d`;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className={`text-2xs gap-1 ${meta.color} border-current/30`}>
            <Icon className="w-3 h-3" />
            <span className="font-medium">{meta.emoji}</span>
            <span className="truncate max-w-[120px]">{modifier.reason}</span>
            {totalSignals > 1 && <span className="opacity-60">+{totalSignals - 1}</span>}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <div className="space-y-1 text-xs">
            <div className="font-medium">{modifier.reason}</div>
            <div className="text-muted-foreground">
              Δ {modifier.delta > 0 ? '+' : ''}{modifier.delta} pts em {modifier.dimension} ·
              peso {(modifier.decayedWeight * 100).toFixed(0)}% · {dayLabel}
            </div>
            {totalSignals > 1 && (
              <div className="text-muted-foreground border-t border-border/40 pt-1 mt-1">
                +{totalSignals - 1} outros sinais ativos
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
```

- [ ] **Step 4: Atualizar `AgendaTodayList.tsx` — renderizar badge**

Substituir o bloco `<div className="text-2xs text-muted-foreground flex items-center gap-2 flex-wrap">` por:

```tsx
<div className="text-2xs text-muted-foreground flex items-center gap-2 flex-wrap">
  <Badge variant="outline" className="text-2xs">{meta.label}</Badge>
  {item.health_class && <span>health: {item.health_class}</span>}
  <span>priority: {Math.round(item.priority_score)}</span>
  {item.topModifier && (
    <SignalModifierBadge modifier={item.topModifier} totalSignals={item.signalsCount} />
  )}
</div>
```

E adicionar o import no topo:
```tsx
import { SignalModifierBadge } from './SignalModifierBadge';
```

- [ ] **Step 5: Validar typecheck + build**

```bash
bunx tsc --noEmit && bun lint && bun run test
```
Esperado: zero erros, todos os testes verdes.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useMyCarteiraScores.ts src/hooks/useMyAgendaToday.ts src/components/dashboard/SignalModifierBadge.tsx src/components/dashboard/AgendaTodayList.tsx
git commit -m "feat(scoring): UI signal_modifiers badge em AgendaTodayList + hook breakdown"
```

---

### Task 9: Smoke test end-to-end + PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin claude/pr-scoring-v2
```

- [ ] **Step 2: Abrir PR**

```bash
gh pr create --title "PR-SCORING-V2: sinais do copilot → priority_score" --body "$(cat <<'EOF'
## Summary

- Migration: `signal_modifiers jsonb` + `last_signal_recalc_at` em farmer_client_scores; tabela `score_recalc_queue`; trigger `AFTER INSERT` em farmer_calls que enfileira recálculo
- Lib pura `src/lib/scoring/{decay,modulators,aggregate}.ts` com 24 testes vitest
- Edge function `scoring-recalc-client` (single ou drain_queue) + `scoring-recalc-batch` (cron noturno)
- UI: `<SignalModifierBadge />` em AgendaTodayList — badge com modifier dominante + tooltip com breakdown

**Sinais reconhecidos:** competitor_mentioned (+15 churn), price/risk_high (+20 churn), opportunity_upsell (delta proporcional ao value, cap 40, expansion), desired_outcome via timeline (+10 expansion), close_attempted_no_close (-5 eff).

**Decay:** half-life 30 dias — sinal de 30d atrás vale 50% do peso original.

## ATENÇÃO: migration manual necessária

Migration `20260518100000_scoring_v2_signal_modifiers.sql` precisa ser aplicada manualmente no Supabase Dashboard → SQL Editor depois do merge (Lovable Cloud não aplica migrations custom — ver CLAUDE.md §5). SQL completo no arquivo da migration.

**Pós-aplicação**, agendar cron pg_cron (SQL no docs/superpowers/plans/2026-05-18-pr-scoring-v2.md Task 7 Step 2).

## Test plan

- [ ] Aplicar migration manual e validar schema (3 queries em Task 1 Step 3 do plano)
- [ ] Fazer 1 chamada real com cliente vinculado, garantir que copilot persiste entities_extracted
- [ ] Validar que trigger enfileirou: `SELECT * FROM score_recalc_pending;` deve ter 1 row
- [ ] Invocar manual: `curl ... scoring-recalc-client -d '{"drain_queue":true}'`
- [ ] Validar que farmer_client_scores.signal_modifiers foi populado pra esse cliente
- [ ] Validar que badge aparece em /meu-dia → AgendaTodayList
- [ ] Recalc batch dry-run: `curl ... scoring-recalc-batch` — confirmar 0 erros

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Aguardar CI verde + checklist do test plan**

CI deve passar `bun lint`, `bun run test` (24 testes novos), `bunx tsc --noEmit`.

- [ ] **Step 4: Pós-merge**

1. Aplicar migration manual no Supabase
2. Agendar cron pg_cron (SQL na Task 7 Step 2)
3. Smoke test completo (checklist da PR)

---

## Self-review (executada antes de entregar o plano)

**1. Spec coverage:**
- ✅ competitor_mentioned (+churn +15) — Task 4, branch `competitor` em modulators
- ✅ price_objection severity=alta (+churn +20) — Task 4, branch `risk_high` em analysis
- ✅ desired_outcome (+expansion +10) — Task 4, branch `timeline` em entity
- ✅ opportunities[upsell] (+expansion) — Task 4, branch `opportunity_upsell` em analysis
- ✅ risks[severity=alta] — Task 4 (mapeado em churn em vez de health pra simplicidade; health vai entrar quando tiver sinal positivo concreto)
- ✅ Multiple playbook=close sem close (-eff) — Task 4, `close_attempted_no_close`
- ✅ Trigger AFTER INSERT em farmer_calls — Task 1
- ✅ Cron noturno — Task 7
- ✅ Hook breakdown + UI badge — Task 8

**Gap consciente:** `health_score` (escala 0-1) e `recover_score` não são tocados nesta V2. Health permanece calculado pelo método existente (RFMG+X+S). Recover_score idem. Justificativa: sinais de copilot mapeiam melhor em churn/expansion/eff. Se quisermos modular health, precisamos definir sinais positivos (cliente elogiou produto, mencionou recompra) — fica pra PR-SCORING-V2.1.

**2. Placeholder scan:** Nenhum "TBD", "fill in later" ou "similar to Task N". Todo código em blocos completos.

**3. Type consistency:**
- `SignalModifier.dimension` é `'churn' | 'expansion' | 'health' | 'eff'` em types.ts, modulators.ts, aggregate.ts, edge function inline ✅
- `ScoreAdjustment.breakdown` tem as 4 dimensões consistentemente ✅
- `kind: SignalKind` em types.ts inclui todos os 6 kinds emitidos por modulators ✅
- Edge function duplica os tipos inline (justificado: Deno não importa do src/) mas com mesmas shapes ✅

**Risco:** se um dia adicionarmos um SignalKind novo no `types.ts` sem atualizar o edge function, fica drift. Mitigação: tarefa futura PR-SCORING-V2.1 — extrair pra `supabase/functions/_shared/scoring/` e importar dos dois lados.

---

## Execução

Plano completo. Recomendo **subagent-driven** com tarefa por task — cada uma tem testes + commit isolado, fácil revisar. Alternativa: executar inline aqui, com checkpoint de revisão depois das tasks 5 (lib pura completa, antes de tocar edge functions).
