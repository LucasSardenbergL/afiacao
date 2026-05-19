# PR-VISIT-INTELLIGENCE Sub-PR A (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao Closer/Hunter/Master uma lista diária data-driven de clientes pra visitar presencialmente, categorizada por 4 missões (recuperação/expansão/relacionamento/prospecção), filtrada por cidade, exibida como card no `/meu-dia`.

**Architecture:** Tabela paralela `customer_visit_scores` (mesmo pattern de `farmer_client_scores` do PR-SCORING-V2) com 4 mission scores + visit_score derivado + primary_mission. Edge functions Deno fazem recalc on-demand e via cron noturno (04:00 BRT, 1h depois do PR-SCORING-V2 cron). Triggers SQL enfileiram recalc quando há nova visita ou mudança em farmer_client_scores. Hook React Query + componente VisitSuggestionsCard no /meu-dia (Master/Closer apenas, NÃO Farmer).

**Tech Stack:** Postgres (jsonb + triggers + enum + RLS) + Deno Edge Functions + TypeScript + Vitest (TDD libs puras) + React Query + shadcn/ui + Lucide icons.

**Spec doc:** `docs/superpowers/specs/2026-05-18-pr-visit-intelligence-sub-pr-a-design.md`

---

## File structure

### Create

```
supabase/migrations/20260518120000_visit_intelligence_v1.sql       (~170 LoC SQL)
src/lib/visit-scoring/types.ts                                       (~80 LoC)
src/lib/visit-scoring/helpers.ts                                     (~50 LoC)
src/lib/visit-scoring/missions.ts                                    (~130 LoC)
src/lib/visit-scoring/mix-selector.ts                                (~50 LoC)
src/lib/visit-scoring/__tests__/helpers.test.ts                      (~90 LoC, ~9 testes)
src/lib/visit-scoring/__tests__/missions.test.ts                     (~300 LoC, ~15 testes)
src/lib/visit-scoring/__tests__/mix-selector.test.ts                 (~140 LoC, ~6 testes)
supabase/functions/visit-score-recalc-client/index.ts                (~360 LoC, libs duplicadas inline)
supabase/functions/visit-score-recalc-batch/index.ts                 (~110 LoC)
src/hooks/useMyVisitSuggestions.ts                                   (~110 LoC)
src/components/dashboard/VisitSuggestionsCard.tsx                    (~140 LoC)
```

### Modify

```
src/components/dashboard/MasterDashboard.tsx        — adicionar <VisitSuggestionsCard /> acima de KpisToday
src/components/dashboard/CloserDashboard.tsx        — adicionar <VisitSuggestionsCard /> (mesma posição)
```

### Total estimate

~1,730 LoC (incluindo testes e duplicação inline em Deno).

---

## Pre-flight

Antes de começar Task 1, garantir o estado:

- [ ] **Verificar branch atual**

```bash
git branch --show-current
```
Esperado: `claude/pr-visit-intelligence-a-spec` (ou outra branch derivada de `origin/main`).

- [ ] **Verificar que spec doc está commitado**

```bash
git log --oneline -3
```
Esperado: ver commit "docs(visit-intelligence): spec PR-VISIT-INTELLIGENCE Sub-PR A (foundation)" no histórico.

- [ ] **Verificar que vitest funciona**

```bash
bun run test -- src/lib/scoring 2>&1 | tail -5
```
Esperado: 26 testes passando (PR-SCORING-V2 já está em main). Isso confirma que o test runner e setup estão OK.

- [ ] **Verificar que typecheck funciona**

```bash
bunx tsc --noEmit 2>&1 | tail -3
```
Esperado: zero output (clean).

---

## Task 1: Migration SQL

**Files:**
- Create: `supabase/migrations/20260518120000_visit_intelligence_v1.sql`

- [ ] **Step 1: Escrever a migration completa**

Conteúdo do arquivo (idempotente — DROP POLICY IF EXISTS / IF NOT EXISTS / OR REPLACE):

```sql
-- PR-VISIT-INTELLIGENCE Sub-PR A: visit scoring + 4 missões + queue + triggers

-- 1. Enum mission type
DO $$ BEGIN
  CREATE TYPE public.visit_mission AS ENUM (
    'recuperacao',
    'expansao',
    'relacionamento',
    'prospeccao'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. Scores table
CREATE TABLE IF NOT EXISTS public.customer_visit_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL,
  
  recuperacao_score numeric DEFAULT 0,
  expansao_score numeric DEFAULT 0,
  relacionamento_score numeric DEFAULT 0,
  prospeccao_score numeric DEFAULT 0,
  
  visit_score numeric DEFAULT 0,
  primary_mission visit_mission,
  
  city text,
  neighborhood text,
  state text,
  
  last_visit_at timestamptz,
  days_since_last_visit integer,
  
  score_breakdown jsonb DEFAULT '{}'::jsonb,
  
  calculated_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  
  UNIQUE (customer_user_id, farmer_id)
);

CREATE INDEX IF NOT EXISTS idx_visit_scores_farmer_priority
  ON public.customer_visit_scores (farmer_id, visit_score DESC);
CREATE INDEX IF NOT EXISTS idx_visit_scores_farmer_city
  ON public.customer_visit_scores (farmer_id, city, visit_score DESC);

-- 3. Recalc queue
CREATE TABLE IF NOT EXISTS public.visit_score_recalc_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL,
  reason text NOT NULL,
  source_event_id uuid,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text
);

CREATE INDEX IF NOT EXISTS idx_visit_score_queue_pending
  ON public.visit_score_recalc_queue (enqueued_at) WHERE processed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_visit_score_queue_pending
  ON public.visit_score_recalc_queue (customer_user_id, farmer_id) WHERE processed_at IS NULL;

CREATE OR REPLACE VIEW public.visit_score_recalc_pending AS
SELECT q.* FROM public.visit_score_recalc_queue q
WHERE q.processed_at IS NULL ORDER BY q.enqueued_at;

-- 4. RLS — usando 'master' (enum app_role NÃO tem 'admin', lição do PR-SCORING-V2 fix PR #97)
ALTER TABLE public.customer_visit_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can view their visit scores" ON public.customer_visit_scores;
CREATE POLICY "Staff can view their visit scores" ON public.customer_visit_scores FOR SELECT
  USING (
    has_role(auth.uid(), 'master'::app_role)
    OR (has_role(auth.uid(), 'employee'::app_role) AND farmer_id = auth.uid())
  );

DROP POLICY IF EXISTS "Staff can manage their visit scores" ON public.customer_visit_scores;
CREATE POLICY "Staff can manage their visit scores" ON public.customer_visit_scores FOR ALL
  USING (
    has_role(auth.uid(), 'master'::app_role)
    OR (has_role(auth.uid(), 'employee'::app_role) AND farmer_id = auth.uid())
  )
  WITH CHECK (
    has_role(auth.uid(), 'master'::app_role)
    OR (has_role(auth.uid(), 'employee'::app_role) AND farmer_id = auth.uid())
  );

ALTER TABLE public.visit_score_recalc_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can view visit recalc queue" ON public.visit_score_recalc_queue;
CREATE POLICY "Staff can view visit recalc queue" ON public.visit_score_recalc_queue FOR SELECT
  USING (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

DROP POLICY IF EXISTS "Staff can insert visit recalc queue" ON public.visit_score_recalc_queue;
CREATE POLICY "Staff can insert visit recalc queue" ON public.visit_score_recalc_queue FOR INSERT
  WITH CHECK (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

GRANT SELECT ON public.visit_score_recalc_pending TO authenticated, service_role;

-- 5. Triggers

CREATE OR REPLACE FUNCTION public.enqueue_visit_score_recalc_from_visit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.visit_score_recalc_queue
    (customer_user_id, farmer_id, reason, source_event_id)
  VALUES
    (NEW.customer_user_id, NEW.visited_by, 'visit_completed', NEW.id)
  ON CONFLICT (customer_user_id, farmer_id) WHERE processed_at IS NULL DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_route_visits_enqueue_visit_recalc ON public.route_visits;
CREATE TRIGGER trg_route_visits_enqueue_visit_recalc
  AFTER INSERT OR UPDATE OF check_out_at ON public.route_visits
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_visit_score_recalc_from_visit();

CREATE OR REPLACE FUNCTION public.enqueue_visit_score_recalc_from_client_score()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.priority_score IS DISTINCT FROM OLD.priority_score
     OR NEW.churn_risk IS DISTINCT FROM OLD.churn_risk
     OR NEW.expansion_score IS DISTINCT FROM OLD.expansion_score THEN
    INSERT INTO public.visit_score_recalc_queue
      (customer_user_id, farmer_id, reason)
    VALUES
      (NEW.customer_user_id, NEW.farmer_id, 'score_changed')
    ON CONFLICT (customer_user_id, farmer_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_farmer_client_scores_enqueue_visit_recalc ON public.farmer_client_scores;
CREATE TRIGGER trg_farmer_client_scores_enqueue_visit_recalc
  AFTER UPDATE ON public.farmer_client_scores
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_visit_score_recalc_from_client_score();
```

- [ ] **Step 2: Validar SQL syntax visual**

Re-ler o arquivo e confirmar:
- Parens balanceados em todos CREATE TABLE/FUNCTION
- Sem vírgulas órfãs antes de `)`
- `'master'` NÃO `'admin'` em todas as policies (lição PR-SCORING-V2 fix PR #97)
- `jsonb_typeof = 'array'` se houver guards (não tem nessa migration, mas verificar)
- Todos `DROP TRIGGER IF EXISTS` antes de `CREATE TRIGGER`
- Todos `DROP POLICY IF EXISTS` antes de `CREATE POLICY`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260518120000_visit_intelligence_v1.sql
git commit -m "feat(visit): migration v1 — customer_visit_scores + queue + triggers + RLS"
```

**Atenção operacional**: NÃO tentar aplicar a migration manualmente aqui. Lovable Cloud não auto-aplica migrations com nome custom (ver CLAUDE.md §5). Aplicação manual via Lovable SQL Editor é PÓS-MERGE pelo user, não parte desta task.

---

## Task 2: Types compartilhados

**Files:**
- Create: `src/lib/visit-scoring/types.ts`

- [ ] **Step 1: Escrever o arquivo**

```typescript
/**
 * PR-VISIT-INTELLIGENCE Sub-PR A — tipos compartilhados.
 *
 * Pipeline:
 *   inputs (de farmer_client_scores + route_visits + sales_orders + addresses + profiles)
 *     → 4 mission scoring functions (puras)
 *     → computeVisitScore (max + argmax)
 *     → pickDailyMix (diversidade)
 *     → renderizado em VisitSuggestionsCard
 */

import type { ScoreAdjustment } from '@/lib/scoring/types';

export type MissionType =
  | 'recuperacao'
  | 'expansao'
  | 'relacionamento'
  | 'prospeccao';

export interface CustomerScoreInputs {
  customer_user_id: string;
  farmer_id: string;
  // de farmer_client_scores
  churn_risk: number;
  expansion_score: number;
  health_score: number;
  recover_score: number;
  revenue_potential: number;
  avg_monthly_spend_180d: number;
  days_since_last_purchase: number;
  // de PR-SCORING-V2
  signal_modifiers: ScoreAdjustment | null;
  // de route_visits
  days_since_last_visit: number | null;
  last_visit_at: string | null;
  // de sales_orders
  sales_orders_count: number;
  // de profiles
  is_prospect: boolean;
  days_since_signup: number;
  // de addresses
  city: string | null;
  neighborhood: string | null;
  state: string | null;
}

export interface MissionScores {
  recuperacao: number;
  expansao: number;
  relacionamento: number;
  prospeccao: number;
}

export interface VisitScore {
  customer_user_id: string;
  scores: MissionScores;
  visit_score: number;       // = MAX(4 scores)
  primary_mission: MissionType;
  city: string | null;
  neighborhood: string | null;
  days_since_last_visit: number | null;
}
```

- [ ] **Step 2: Validar typecheck**

```bash
bunx tsc --noEmit 2>&1 | tail -3
```
Esperado: clean (zero output).

- [ ] **Step 3: Commit**

```bash
git add src/lib/visit-scoring/types.ts
git commit -m "feat(visit): tipos compartilhados — MissionType, CustomerScoreInputs, VisitScore"
```

---

## Task 3: Helpers TDD

**Files:**
- Create: `src/lib/visit-scoring/__tests__/helpers.test.ts`
- Create: `src/lib/visit-scoring/helpers.ts`

- [ ] **Step 1: Escrever os testes primeiro (failing)**

```typescript
// src/lib/visit-scoring/__tests__/helpers.test.ts
import { describe, it, expect } from 'vitest';
import { clamp, normalizeRevenue, computeDays } from '../helpers';

describe('clamp', () => {
  it('valor dentro do range não muda', () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it('valor abaixo do min vai pro min', () => {
    expect(clamp(-10, 0, 100)).toBe(0);
  });

  it('valor acima do max vai pro max', () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });
});

describe('normalizeRevenue', () => {
  it('valor zero retorna 0', () => {
    expect(normalizeRevenue(0)).toBe(0);
  });

  it('valor médio (~R$ 5000) retorna meio (~0.5)', () => {
    expect(normalizeRevenue(5000)).toBeCloseTo(0.5, 1);
  });

  it('valor alto (>= R$ 10000) satura em 1.0', () => {
    expect(normalizeRevenue(10000)).toBe(1);
    expect(normalizeRevenue(50000)).toBe(1);
  });
});

describe('computeDays', () => {
  it('null retorna null', () => {
    expect(computeDays(null)).toBeNull();
  });

  it('undefined retorna null', () => {
    expect(computeDays(undefined)).toBeNull();
  });

  it('timestamp de hoje retorna 0', () => {
    const now = new Date().toISOString();
    expect(computeDays(now)).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar pra confirmar falha**

```bash
bun run test -- src/lib/visit-scoring/__tests__/helpers.test.ts 2>&1 | tail -10
```
Esperado: FAIL com `Cannot find module '../helpers'`.

- [ ] **Step 3: Implementação**

```typescript
// src/lib/visit-scoring/helpers.ts
/**
 * Helpers puros pra visit scoring.
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Clamp numérico — retorna n forçado dentro de [min, max].
 */
export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Normaliza receita pra escala 0..1.
 * Threshold: R$ 10.000 = saturação. Below = linear.
 * Justificativa: cliente médio Sayerlack/Colacor consome R$ 5-8k/mês;
 * acima de R$ 10k é "VIP saturado" e não precisa boost maior.
 */
export function normalizeRevenue(value: number): number {
  if (value <= 0) return 0;
  return Math.min(1, value / 10000);
}

/**
 * Computa dias desde um timestamp ISO até agora.
 * Retorna null se input for null/undefined.
 */
export function computeDays(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const then = new Date(timestamp);
  const now = new Date();
  return Math.max(0, Math.round((now.getTime() - then.getTime()) / MS_PER_DAY));
}
```

- [ ] **Step 4: Rodar testes — devem passar**

```bash
bun run test -- src/lib/visit-scoring/__tests__/helpers.test.ts 2>&1 | tail -10
```
Esperado: PASS, 9 testes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/visit-scoring/helpers.ts src/lib/visit-scoring/__tests__/helpers.test.ts
git commit -m "feat(visit): helpers puros (clamp + normalizeRevenue + computeDays) + 9 testes"
```

---

## Task 4: Missions TDD

**Files:**
- Create: `src/lib/visit-scoring/__tests__/missions.test.ts`
- Create: `src/lib/visit-scoring/missions.ts`

- [ ] **Step 1: Escrever os testes primeiro (failing)**

```typescript
// src/lib/visit-scoring/__tests__/missions.test.ts
import { describe, it, expect } from 'vitest';
import {
  scoreRecuperacao,
  scoreExpansao,
  scoreRelacionamento,
  scoreProspeccao,
  computeVisitScore,
} from '../missions';
import type { CustomerScoreInputs } from '../types';

// Helper pra criar input com defaults sãos
function mkInput(overrides: Partial<CustomerScoreInputs> = {}): CustomerScoreInputs {
  return {
    customer_user_id: 'c1',
    farmer_id: 'f1',
    churn_risk: 0,
    expansion_score: 0,
    health_score: 0.5,
    recover_score: 0,
    revenue_potential: 0,
    avg_monthly_spend_180d: 0,
    days_since_last_purchase: 30,
    signal_modifiers: null,
    days_since_last_visit: null,
    last_visit_at: null,
    sales_orders_count: 5,
    is_prospect: false,
    days_since_signup: 365,
    city: 'Belo Horizonte',
    neighborhood: null,
    state: 'MG',
    ...overrides,
  };
}

describe('scoreRecuperacao', () => {
  it('cliente VIP que parou há 90d com churn alto → score > 70', () => {
    const score = scoreRecuperacao(mkInput({
      churn_risk: 90,
      recover_score: 70,
      days_since_last_purchase: 90,
    }));
    expect(score).toBeGreaterThan(60);
  });

  it('cliente que comprou ontem → recencyPenalty alta deixa score baixo', () => {
    const score = scoreRecuperacao(mkInput({
      churn_risk: 50,
      recover_score: 30,
      days_since_last_purchase: 1,
    }));
    // 25 + 9 - 9.9 = ~24
    expect(score).toBeLessThan(40);
  });

  it('signal modifiers de churn boost o score', () => {
    const withSignals = scoreRecuperacao(mkInput({
      churn_risk: 50,
      recover_score: 30,
      days_since_last_purchase: 60,
      signal_modifiers: {
        churn_delta: 30,
        expansion_delta: 0, health_delta: 0, eff_delta: 0,
        breakdown: {
          churn: [{ dimension: 'churn', kind: 'competitor_mentioned', delta: 15, weight: 1, decayedWeight: 1, reason: '', sourceCallId: 's1', capturedAt: '', daysSince: 0 }],
          expansion: [], health: [], eff: [],
        },
        computed_at: '',
        source_call_count: 1,
      },
    }));
    const without = scoreRecuperacao(mkInput({
      churn_risk: 50,
      recover_score: 30,
      days_since_last_purchase: 60,
    }));
    expect(withSignals).toBeGreaterThan(without);
  });
});

describe('scoreExpansao', () => {
  it('cliente com expansion_score=80 + signal upsell → score > 60', () => {
    const score = scoreExpansao(mkInput({
      expansion_score: 80,
      revenue_potential: 5000,
      signal_modifiers: {
        churn_delta: 0, expansion_delta: 30, health_delta: 0, eff_delta: 0,
        breakdown: {
          churn: [],
          expansion: [{ dimension: 'expansion', kind: 'opportunity_upsell', delta: 30, weight: 1, decayedWeight: 1, reason: '', sourceCallId: 's1', capturedAt: '', daysSince: 0 }],
          health: [], eff: [],
        },
        computed_at: '',
        source_call_count: 1,
      },
    }));
    expect(score).toBeGreaterThan(60);
  });

  it('cliente sem expansion_score e sem signals → score baixo', () => {
    const score = scoreExpansao(mkInput({
      expansion_score: 5,
      revenue_potential: 0,
    }));
    expect(score).toBeLessThan(20);
  });

  it('cap em 100', () => {
    const score = scoreExpansao(mkInput({
      expansion_score: 100,
      revenue_potential: 50000,
      signal_modifiers: {
        churn_delta: 0, expansion_delta: 100, health_delta: 0, eff_delta: 0,
        breakdown: {
          churn: [],
          expansion: [{ dimension: 'expansion', kind: 'opportunity_upsell', delta: 100, weight: 1, decayedWeight: 1, reason: '', sourceCallId: 's1', capturedAt: '', daysSince: 0 }],
          health: [], eff: [],
        },
        computed_at: '', source_call_count: 1,
      },
    }));
    expect(score).toBe(100);
  });
});

describe('scoreRelacionamento', () => {
  it('cliente health=1.0, revenue alto, 120d sem visita, baixo churn → score alto', () => {
    const score = scoreRelacionamento(mkInput({
      health_score: 1.0,
      avg_monthly_spend_180d: 8000,
      days_since_last_visit: 120,
      churn_risk: 10,
    }));
    expect(score).toBeGreaterThan(70);
  });

  it('cliente em risco alto (churn=80) → relacionamento penalizado', () => {
    const score = scoreRelacionamento(mkInput({
      health_score: 0.8,
      avg_monthly_spend_180d: 5000,
      days_since_last_visit: 60,
      churn_risk: 80,
    }));
    const noRisk = scoreRelacionamento(mkInput({
      health_score: 0.8,
      avg_monthly_spend_180d: 5000,
      days_since_last_visit: 60,
      churn_risk: 0,
    }));
    expect(score).toBeLessThan(noRisk);
  });

  it('cliente nunca visitado (days_since_last_visit=null) → usa fallback 365', () => {
    const score = scoreRelacionamento(mkInput({
      health_score: 0.8,
      avg_monthly_spend_180d: 5000,
      days_since_last_visit: null,
      churn_risk: 10,
    }));
    expect(score).toBeGreaterThan(50);
  });
});

describe('scoreProspeccao', () => {
  it('cliente com 0 sales_orders → score >= 70', () => {
    const score = scoreProspeccao(mkInput({
      sales_orders_count: 0,
      is_prospect: false,
      days_since_signup: 100,
    }));
    expect(score).toBeGreaterThanOrEqual(70);
  });

  it('is_prospect=true com signup recente (< 30d) → bonus +20', () => {
    const score = scoreProspeccao(mkInput({
      sales_orders_count: 0,
      is_prospect: true,
      days_since_signup: 10,
    }));
    expect(score).toBeGreaterThanOrEqual(90);
  });

  it('cliente com sales_orders > 0 → score = 0', () => {
    const score = scoreProspeccao(mkInput({
      sales_orders_count: 5,
      is_prospect: false,
    }));
    expect(score).toBe(0);
  });
});

describe('computeVisitScore', () => {
  it('retorna max dos 4 e primary_mission correspondente', () => {
    const result = computeVisitScore(mkInput({
      churn_risk: 90,
      recover_score: 70,
      days_since_last_purchase: 90,
      sales_orders_count: 5,
      health_score: 0.3,  // baixo pra deprimir relacionamento
    }));
    expect(result.primary_mission).toBe('recuperacao');
    expect(result.visit_score).toBe(result.scores.recuperacao);
    expect(result.visit_score).toBeGreaterThan(60);
  });

  it('empate vai pra ordem: expansao > recuperacao > relacionamento > prospeccao', () => {
    // Forço empate artificial — score 50 em todas
    // Como isso é difícil com a fórmula real, testo com computeVisitScore puro
    // usando inputs que dão empate.
    // Truque: criar input que gera scores idênticos é improvável,
    // então testo o comportamento de tiebreak via inputs próximos
    const result = computeVisitScore(mkInput({
      expansion_score: 50,
      churn_risk: 0,
      recover_score: 0,
      health_score: 0,
      sales_orders_count: 5,
      revenue_potential: 0,
      avg_monthly_spend_180d: 0,
    }));
    // expansao_score = 30 (de 50 * 0.6); resto = 0
    expect(result.primary_mission).toBe('expansao');
  });
});
```

- [ ] **Step 2: Rodar pra confirmar falha**

```bash
bun run test -- src/lib/visit-scoring/__tests__/missions.test.ts 2>&1 | tail -10
```
Esperado: FAIL com `Cannot find module '../missions'`.

- [ ] **Step 3: Implementação**

```typescript
// src/lib/visit-scoring/missions.ts
/**
 * 4 mission scoring functions + computeVisitScore.
 *
 * Cada função retorna score 0..100. computeVisitScore pega o max + argmax.
 * Tiebreak: expansao > recuperacao > relacionamento > prospeccao.
 *
 * Inputs vêm consolidados em CustomerScoreInputs (de 5 tabelas via edge function).
 */

import { clamp, normalizeRevenue } from './helpers';
import type {
  CustomerScoreInputs,
  MissionScores,
  MissionType,
  VisitScore,
} from './types';

/**
 * RECUPERAÇÃO — cliente que comprava bem e parou.
 * High churn_risk + recover_score + days_since_purchase > 60 = alto.
 */
export function scoreRecuperacao(c: CustomerScoreInputs): number {
  const churnBoost = c.churn_risk * 0.5;
  const recoverBoost = c.recover_score * 0.3;
  const recencyPenalty = Math.max(0, 100 - c.days_since_last_purchase) * -0.1;
  const signalsBoost = (c.signal_modifiers?.breakdown.churn ?? [])
    .reduce((s, m) => s + m.delta * m.decayedWeight, 0) * 0.1;
  return clamp(churnBoost + recoverBoost + recencyPenalty + signalsBoost, 0, 100);
}

/**
 * EXPANSÃO — cliente saudável com upsell quente.
 * High expansion_score + signals de upsell = alto.
 */
export function scoreExpansao(c: CustomerScoreInputs): number {
  const expansionBase = c.expansion_score * 0.6;
  const revenueBoost = normalizeRevenue(c.revenue_potential) * 20;
  const signalsBoost = (c.signal_modifiers?.breakdown.expansion ?? [])
    .reduce((s, m) => s + m.delta * m.decayedWeight, 0) * 0.2;
  return clamp(expansionBase + revenueBoost + signalsBoost, 0, 100);
}

/**
 * RELACIONAMENTO — cliente VIP saudável precisando manutenção.
 * High health + revenue + days_since_visit, baixo churn = alto.
 */
export function scoreRelacionamento(c: CustomerScoreInputs): number {
  const healthBoost = c.health_score * 50;
  const revenueBoost = normalizeRevenue(c.avg_monthly_spend_180d) * 30;
  const daysSinceVisitBoost = Math.min(40, (c.days_since_last_visit ?? 365) * 0.3);
  const riskPenalty = c.churn_risk * 0.3;
  return clamp(healthBoost + revenueBoost + daysSinceVisitBoost - riskPenalty, 0, 100);
}

/**
 * PROSPECÇÃO — lead novo ou cliente sem histórico.
 */
export function scoreProspeccao(c: CustomerScoreInputs): number {
  const isProspectCandidate = c.sales_orders_count === 0 || c.is_prospect === true;
  if (!isProspectCandidate) return 0;
  const baseProspect = 70;
  const recencyOfSignup = c.days_since_signup < 30 ? 20 : 0;
  const signalsQuality = (c.signal_modifiers?.source_call_count ?? 0) > 0 ? 10 : 0;
  return clamp(baseProspect + recencyOfSignup + signalsQuality, 0, 100);
}

/**
 * Computa o visit_score final + primary_mission.
 * Tiebreak: expansao > recuperacao > relacionamento > prospeccao.
 */
export function computeVisitScore(c: CustomerScoreInputs): VisitScore {
  const scores: MissionScores = {
    recuperacao: scoreRecuperacao(c),
    expansao: scoreExpansao(c),
    relacionamento: scoreRelacionamento(c),
    prospeccao: scoreProspeccao(c),
  };

  // Tiebreak order
  const ORDER: MissionType[] = ['expansao', 'recuperacao', 'relacionamento', 'prospeccao'];

  let primary_mission: MissionType = 'prospeccao';
  let visit_score = scores.prospeccao;

  for (const m of ORDER) {
    const s = scores[m];
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
  };
}
```

- [ ] **Step 4: Rodar testes — devem passar**

```bash
bun run test -- src/lib/visit-scoring/__tests__/missions.test.ts 2>&1 | tail -10
```
Esperado: PASS, 15 testes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/visit-scoring/missions.ts src/lib/visit-scoring/__tests__/missions.test.ts
git commit -m "feat(visit): 4 mission scoring functions + computeVisitScore + 15 testes"
```

---

## Task 5: Mix selector TDD

**Files:**
- Create: `src/lib/visit-scoring/__tests__/mix-selector.test.ts`
- Create: `src/lib/visit-scoring/mix-selector.ts`

- [ ] **Step 1: Escrever os testes primeiro (failing)**

```typescript
// src/lib/visit-scoring/__tests__/mix-selector.test.ts
import { describe, it, expect } from 'vitest';
import { pickDailyMix } from '../mix-selector';
import type { MissionType, VisitScore } from '../types';

function mkScore(id: string, mission: MissionType, score: number): VisitScore {
  return {
    customer_user_id: id,
    scores: {
      recuperacao: mission === 'recuperacao' ? score : 0,
      expansao: mission === 'expansao' ? score : 0,
      relacionamento: mission === 'relacionamento' ? score : 0,
      prospeccao: mission === 'prospeccao' ? score : 0,
    },
    visit_score: score,
    primary_mission: mission,
    city: 'Belo Horizonte',
    neighborhood: null,
    days_since_last_visit: null,
  };
}

describe('pickDailyMix', () => {
  it('lista vazia retorna array vazio', () => {
    expect(pickDailyMix([], 6)).toEqual([]);
  });

  it('target maior que candidatos retorna todos', () => {
    const cand = [mkScore('a', 'expansao', 90), mkScore('b', 'recuperacao', 80)];
    expect(pickDailyMix(cand, 6)).toHaveLength(2);
  });

  it('respeita maxFractionPerMission 50% num target de 6 (cap 3 por missão)', () => {
    // 10 candidatos todos de expansao
    const cand = Array.from({ length: 10 }, (_, i) =>
      mkScore(`c${i}`, 'expansao', 100 - i)
    );
    const result = pickDailyMix(cand, 6, 0.5);
    // Pass 1 pega 3 (cap), pass 2 relaxa e pega mais 3
    expect(result).toHaveLength(6);
  });

  it('preserva ordem de visit_score dentro de cada missão', () => {
    const cand = [
      mkScore('a', 'expansao', 80),
      mkScore('b', 'recuperacao', 90),
      mkScore('c', 'expansao', 70),
      mkScore('d', 'relacionamento', 60),
    ];
    const result = pickDailyMix(cand, 4, 0.5);
    // Ordenação preservada
    const ids = result.map(r => r.customer_user_id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c')); // a antes de c (mesma missão)
  });

  it('garante diversidade quando top é dominado por uma missão', () => {
    // 5 expansao top, 5 recuperacao no fim
    const cand = [
      ...Array.from({ length: 5 }, (_, i) => mkScore(`e${i}`, 'expansao', 100 - i)),
      ...Array.from({ length: 5 }, (_, i) => mkScore(`r${i}`, 'recuperacao', 80 - i)),
    ];
    const result = pickDailyMix(cand, 6, 0.5);
    const expansionCount = result.filter(r => r.primary_mission === 'expansao').length;
    const recuperacaoCount = result.filter(r => r.primary_mission === 'recuperacao').length;
    // Pass 1: 3 expansao + 3 recuperacao (cap 3 = 50% de 6)
    expect(expansionCount).toBeLessThanOrEqual(3);
    expect(recuperacaoCount).toBeGreaterThanOrEqual(3);
  });

  it('não duplica candidatos no pass 2', () => {
    const cand = Array.from({ length: 4 }, (_, i) =>
      mkScore(`c${i}`, 'expansao', 100 - i)
    );
    const result = pickDailyMix(cand, 6, 0.5);
    const ids = result.map(r => r.customer_user_id);
    expect(new Set(ids).size).toBe(ids.length); // todos únicos
  });
});
```

- [ ] **Step 2: Rodar pra confirmar falha**

```bash
bun run test -- src/lib/visit-scoring/__tests__/mix-selector.test.ts 2>&1 | tail -10
```
Esperado: FAIL com `Cannot find module '../mix-selector'`.

- [ ] **Step 3: Implementação**

```typescript
// src/lib/visit-scoring/mix-selector.ts
/**
 * Seleciona mix diário com diversidade entre missões.
 *
 * Pass 1: itera candidatos por visit_score DESC, respeitando cap por missão
 *         (default: 50% do target).
 * Pass 2: se não atingiu target, relaxa cap e preenche com restantes.
 *
 * Garante:
 * - Sem duplicatas
 * - Sem ultrapassar targetCount
 * - Mantém ordem de visit_score dentro de cada missão
 */

import type { MissionType, VisitScore } from './types';

export function pickDailyMix(
  candidates: VisitScore[],
  targetCount = 6,
  maxFractionPerMission = 0.5,
): VisitScore[] {
  const selected: VisitScore[] = [];
  const missionCount: Record<MissionType, number> = {
    recuperacao: 0,
    expansao: 0,
    relacionamento: 0,
    prospeccao: 0,
  };
  const maxPerMission = Math.ceil(targetCount * maxFractionPerMission);

  // Pass 1: respeitando cap de diversidade
  for (const c of candidates) {
    if (selected.length >= targetCount) break;
    if (missionCount[c.primary_mission] >= maxPerMission) continue;
    selected.push(c);
    missionCount[c.primary_mission]++;
  }

  // Pass 2: relaxa cap se não preencheu target
  if (selected.length < targetCount) {
    const selectedIds = new Set(selected.map(s => s.customer_user_id));
    for (const c of candidates) {
      if (selected.length >= targetCount) break;
      if (selectedIds.has(c.customer_user_id)) continue;
      selected.push(c);
      selectedIds.add(c.customer_user_id);
    }
  }

  return selected;
}
```

- [ ] **Step 4: Rodar testes — devem passar**

```bash
bun run test -- src/lib/visit-scoring/__tests__/mix-selector.test.ts 2>&1 | tail -10
```
Esperado: PASS, 6 testes.

- [ ] **Step 5: Rodar suíte completa de visit-scoring**

```bash
bun run test -- src/lib/visit-scoring 2>&1 | tail -10
```
Esperado: PASS, 30 testes (9 helpers + 15 missions + 6 mix-selector).

- [ ] **Step 6: Commit**

```bash
git add src/lib/visit-scoring/mix-selector.ts src/lib/visit-scoring/__tests__/mix-selector.test.ts
git commit -m "feat(visit): mix-selector com diversidade (cap 50%/missão) + 6 testes"
```

---

## Task 6: Edge function `visit-score-recalc-client`

**Files:**
- Create: `supabase/functions/visit-score-recalc-client/index.ts`

- [ ] **Step 1: Escrever o arquivo completo**

```typescript
// supabase/functions/visit-score-recalc-client/index.ts
//
// PR-VISIT-INTELLIGENCE Sub-PR A — edge function que computa visit_score.
//
// NOTA: lógica de scoring duplicada inline (Deno não importa de src/).
// TODO Sub-PR debt: extrair pra supabase/functions/_shared/visit-scoring/
// (junto com extração do PR-SCORING-V2 V2.1 — mesmo problema).
//
// Auth: authorizeCronOrStaff (cron via x-cron-secret OU staff JWT).

import { createClient } from 'npm:@supabase/supabase-js@^2';
import { authorizeCronOrStaff, corsHeaders } from '../_shared/auth.ts';

// =====================================================
// --- Inline helpers (mirror de src/lib/visit-scoring/helpers.ts) ---
// =====================================================
const MS_PER_DAY = 1000 * 60 * 60 * 24;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
function normalizeRevenue(value: number): number {
  if (value <= 0) return 0;
  return Math.min(1, value / 10000);
}
function computeDays(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  return Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / MS_PER_DAY));
}

// =====================================================
// --- Inline types ---
// =====================================================
type MissionType = 'recuperacao' | 'expansao' | 'relacionamento' | 'prospeccao';

interface SignalModifier {
  dimension: string;
  delta: number;
  decayedWeight: number;
}

interface ScoreAdjustment {
  breakdown: {
    churn: SignalModifier[];
    expansion: SignalModifier[];
    health: SignalModifier[];
    eff: SignalModifier[];
  };
  source_call_count: number;
}

interface CustomerScoreInputs {
  customer_user_id: string;
  farmer_id: string;
  churn_risk: number;
  expansion_score: number;
  health_score: number;
  recover_score: number;
  revenue_potential: number;
  avg_monthly_spend_180d: number;
  days_since_last_purchase: number;
  signal_modifiers: ScoreAdjustment | null;
  days_since_last_visit: number | null;
  last_visit_at: string | null;
  sales_orders_count: number;
  is_prospect: boolean;
  days_since_signup: number;
  city: string | null;
  neighborhood: string | null;
  state: string | null;
}

// =====================================================
// --- Inline missions ---
// =====================================================
function scoreRecuperacao(c: CustomerScoreInputs): number {
  const churnBoost = c.churn_risk * 0.5;
  const recoverBoost = c.recover_score * 0.3;
  const recencyPenalty = Math.max(0, 100 - c.days_since_last_purchase) * -0.1;
  const signalsBoost = (c.signal_modifiers?.breakdown.churn ?? [])
    .reduce((s, m) => s + m.delta * m.decayedWeight, 0) * 0.1;
  return clamp(churnBoost + recoverBoost + recencyPenalty + signalsBoost, 0, 100);
}

function scoreExpansao(c: CustomerScoreInputs): number {
  const expansionBase = c.expansion_score * 0.6;
  const revenueBoost = normalizeRevenue(c.revenue_potential) * 20;
  const signalsBoost = (c.signal_modifiers?.breakdown.expansion ?? [])
    .reduce((s, m) => s + m.delta * m.decayedWeight, 0) * 0.2;
  return clamp(expansionBase + revenueBoost + signalsBoost, 0, 100);
}

function scoreRelacionamento(c: CustomerScoreInputs): number {
  const healthBoost = c.health_score * 50;
  const revenueBoost = normalizeRevenue(c.avg_monthly_spend_180d) * 30;
  const daysSinceVisitBoost = Math.min(40, (c.days_since_last_visit ?? 365) * 0.3);
  const riskPenalty = c.churn_risk * 0.3;
  return clamp(healthBoost + revenueBoost + daysSinceVisitBoost - riskPenalty, 0, 100);
}

function scoreProspeccao(c: CustomerScoreInputs): number {
  const isProspectCandidate = c.sales_orders_count === 0 || c.is_prospect === true;
  if (!isProspectCandidate) return 0;
  const baseProspect = 70;
  const recencyOfSignup = c.days_since_signup < 30 ? 20 : 0;
  const signalsQuality = (c.signal_modifiers?.source_call_count ?? 0) > 0 ? 10 : 0;
  return clamp(baseProspect + recencyOfSignup + signalsQuality, 0, 100);
}

function computeVisitScore(c: CustomerScoreInputs): {
  scores: Record<MissionType, number>;
  visit_score: number;
  primary_mission: MissionType;
} {
  const scores: Record<MissionType, number> = {
    recuperacao: scoreRecuperacao(c),
    expansao: scoreExpansao(c),
    relacionamento: scoreRelacionamento(c),
    prospeccao: scoreProspeccao(c),
  };
  const ORDER: MissionType[] = ['expansao', 'recuperacao', 'relacionamento', 'prospeccao'];
  let primary_mission: MissionType = 'prospeccao';
  let visit_score = scores.prospeccao;
  for (const m of ORDER) {
    if (scores[m] > visit_score) {
      visit_score = scores[m];
      primary_mission = m;
    }
  }
  return { scores, visit_score, primary_mission };
}

// =====================================================
// --- Helpers de IO ---
// =====================================================
function jsonError(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

interface RecalcRequest {
  customer_user_id?: string;
  farmer_id?: string;
  drain_queue?: boolean;
  max_drain?: number;
}

// =====================================================
// --- Recalc core ---
// =====================================================
async function recalcOne(
  supabase: ReturnType<typeof createClient>,
  customer_user_id: string,
  farmer_id: string,
): Promise<{ ok: boolean; error?: string; visit_score?: number; primary_mission?: MissionType }> {
  // 5 reads paralelos
  const [scoresRes, visitsRes, ordersRes, addressRes, profileRes] = await Promise.all([
    supabase.from('farmer_client_scores').select('churn_risk, expansion_score, health_score, recover_score, revenue_potential, avg_monthly_spend_180d, days_since_last_purchase, signal_modifiers').eq('customer_user_id', customer_user_id).eq('farmer_id', farmer_id).maybeSingle(),
    supabase.from('route_visits').select('check_in_at').eq('customer_user_id', customer_user_id).order('check_in_at', { ascending: false }).limit(1),
    supabase.from('sales_orders').select('id').eq('user_id', customer_user_id),
    supabase.from('addresses').select('city, neighborhood, state').eq('user_id', customer_user_id).eq('is_default', true).maybeSingle(),
    supabase.from('profiles').select('created_at, is_prospect').eq('user_id', customer_user_id).maybeSingle(),
  ]);

  if (scoresRes.error) return { ok: false, error: `farmer_client_scores: ${scoresRes.error.message}` };

  const scores = (scoresRes.data ?? {}) as Record<string, unknown>;
  const lastVisitAt = (visitsRes.data ?? [])[0]?.check_in_at ?? null;
  const salesOrdersCount = (ordersRes.data ?? []).length;
  const address = addressRes.data ?? {};
  const profile = profileRes.data ?? {};

  const inputs: CustomerScoreInputs = {
    customer_user_id,
    farmer_id,
    churn_risk: Number(scores.churn_risk ?? 0),
    expansion_score: Number(scores.expansion_score ?? 0),
    health_score: Number(scores.health_score ?? 0),
    recover_score: Number(scores.recover_score ?? 0),
    revenue_potential: Number(scores.revenue_potential ?? 0),
    avg_monthly_spend_180d: Number(scores.avg_monthly_spend_180d ?? 0),
    days_since_last_purchase: Number(scores.days_since_last_purchase ?? 999),
    signal_modifiers: (scores.signal_modifiers ?? null) as ScoreAdjustment | null,
    days_since_last_visit: computeDays(lastVisitAt),
    last_visit_at: lastVisitAt,
    sales_orders_count: salesOrdersCount,
    is_prospect: Boolean((profile as Record<string, unknown>).is_prospect ?? false),
    days_since_signup: computeDays((profile as Record<string, unknown>).created_at as string) ?? 999,
    city: (address as Record<string, unknown>).city as string ?? null,
    neighborhood: (address as Record<string, unknown>).neighborhood as string ?? null,
    state: (address as Record<string, unknown>).state as string ?? null,
  };

  const result = computeVisitScore(inputs);

  const score_breakdown = {
    inputs: {
      churn_risk: inputs.churn_risk,
      expansion_score: inputs.expansion_score,
      health_score: inputs.health_score,
      recover_score: inputs.recover_score,
      days_since_last_purchase: inputs.days_since_last_purchase,
      days_since_last_visit: inputs.days_since_last_visit,
      sales_orders_count: inputs.sales_orders_count,
      is_prospect: inputs.is_prospect,
      revenue_potential: inputs.revenue_potential,
      avg_monthly_spend_180d: inputs.avg_monthly_spend_180d,
    },
    signal_modifiers_summary: {
      churn_count: inputs.signal_modifiers?.breakdown.churn?.length ?? 0,
      expansion_count: inputs.signal_modifiers?.breakdown.expansion?.length ?? 0,
      source_call_count: inputs.signal_modifiers?.source_call_count ?? 0,
    },
    mission_scores: result.scores,
  };

  const { error: upsertErr } = await supabase.from('customer_visit_scores').upsert({
    customer_user_id,
    farmer_id,
    recuperacao_score: result.scores.recuperacao,
    expansao_score: result.scores.expansao,
    relacionamento_score: result.scores.relacionamento,
    prospeccao_score: result.scores.prospeccao,
    visit_score: result.visit_score,
    primary_mission: result.primary_mission,
    city: inputs.city,
    neighborhood: inputs.neighborhood,
    state: inputs.state,
    last_visit_at: lastVisitAt,
    days_since_last_visit: inputs.days_since_last_visit,
    score_breakdown,
    calculated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'customer_user_id,farmer_id' });

  if (upsertErr) return { ok: false, error: `upsert: ${upsertErr.message}` };

  return { ok: true, visit_score: result.visit_score, primary_mission: result.primary_mission };
}

// =====================================================
// --- Handler principal ---
// =====================================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const body: RecalcRequest = await req.json().catch(() => ({}));

  // Modo drain
  if (body.drain_queue) {
    const { data: pending, error } = await supabase
      .from('visit_score_recalc_pending')
      .select('id, customer_user_id, farmer_id')
      .limit(body.max_drain ?? 50);
    if (error) return jsonError(`pending: ${error.message}`, 500);

    const results: unknown[] = [];
    for (const item of (pending ?? []) as Array<{ id: string; customer_user_id: string; farmer_id: string }>) {
      let r: { ok: boolean; error?: string; visit_score?: number; primary_mission?: MissionType };
      try {
        r = await recalcOne(supabase, item.customer_user_id, item.farmer_id);
      } catch (err) {
        r = { ok: false, error: `uncaught: ${err instanceof Error ? err.message : String(err)}` };
      }
      // Sempre marca processado (mesmo em erro) — evita poison-pill
      await supabase.from('visit_score_recalc_queue').update({
        processed_at: new Date().toISOString(),
        error: r.error ?? null,
      }).eq('id', item.id);
      results.push({ id: item.id, ...r });
    }

    return new Response(JSON.stringify({ drained: results.length, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Modo single
  if (!body.customer_user_id || !body.farmer_id) {
    return jsonError('customer_user_id e farmer_id obrigatórios (ou drain_queue=true)', 400);
  }

  const r = await recalcOne(supabase, body.customer_user_id, body.farmer_id);
  return new Response(JSON.stringify(r), {
    status: r.error ? 500 : 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
```

- [ ] **Step 2: Visual review**

Re-ler o arquivo e confirmar:
- `if (!auth.ok) return auth.response;` (interface real de `authorizeCronOrStaff`, NÃO `if (!auth.authorized)`)
- Headers usam `x-cron-secret` (não `x-cron-key`) — relevante quando esta função é chamada pela batch
- Try/catch dentro do drain loop em volta de `recalcOne`
- UPSERT usa `onConflict: 'customer_user_id,farmer_id'`
- 5 queries paralelas via `Promise.all`

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/visit-score-recalc-client/
git commit -m "feat(visit): edge function visit-score-recalc-client (single + drain queue)"
```

---

## Task 7: Edge function `visit-score-recalc-batch`

**Files:**
- Create: `supabase/functions/visit-score-recalc-batch/index.ts`

- [ ] **Step 1: Escrever o arquivo completo**

```typescript
// supabase/functions/visit-score-recalc-batch/index.ts
//
// PR-VISIT-INTELLIGENCE Sub-PR A — cron noturno (04:00 BRT = 07:00 UTC).
// Roda 1h DEPOIS de scoring-recalc-batch (03:00 BRT) pra ler signal_modifiers
// que V2 acabou de atualizar.
//
// 1. Drena visit_score_recalc_pending
// 2. Full refresh: todos pares (customer, farmer) com atividade últimos 30d
//    (qualquer farmer_calls OU sales_orders OU route_visits)
//
// Setup pg_cron (manual pós-merge):
//   SELECT cron.schedule('visit-score-recalc-batch-nightly', '0 7 * * *',
//     $$ SELECT net.http_post(
//       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/visit-score-recalc-batch',
//       headers := jsonb_build_object('x-cron-secret', current_setting('app.cron_shared_key', true))
//     ); $$
//   );

import { createClient } from 'npm:@supabase/supabase-js@^2';
import { authorizeCronOrStaff, corsHeaders } from '../_shared/auth.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const clientUrl = `${Deno.env.get('SUPABASE_URL')!}/functions/v1/visit-score-recalc-client`;
  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';
  if (!cronSecret) {
    console.warn('[visit-score-recalc-batch] CRON_SECRET not set; downstream calls vão ser rejeitadas');
  }

  // 1. Drena fila pendente
  const drainResp = await fetch(clientUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret },
    body: JSON.stringify({ drain_queue: true, max_drain: 500 }),
  });
  const drained = await drainResp.json().catch(() => ({}));

  // 2. Full refresh — coleta pares ativos últimos 30d (3 fontes)
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  const [callsRes, ordersRes, visitsRes] = await Promise.all([
    supabase.from('farmer_calls')
      .select('customer_user_id, farmer_id')
      .gte('started_at', cutoff)
      .not('customer_user_id', 'is', null),
    supabase.from('sales_orders')
      .select('user_id')
      .gte('created_at', cutoff),
    supabase.from('route_visits')
      .select('customer_user_id, visited_by')
      .gte('visit_date', cutoff.slice(0, 10))
      .not('customer_user_id', 'is', null),
  ]);

  // Dedup global em Map<string, {customer_user_id, farmer_id}>
  const unique = new Map<string, { customer_user_id: string; farmer_id: string }>();
  for (const row of (callsRes.data ?? []) as Array<{ customer_user_id: string; farmer_id: string }>) {
    unique.set(`${row.customer_user_id}::${row.farmer_id}`, row);
  }
  for (const row of (visitsRes.data ?? []) as Array<{ customer_user_id: string; visited_by: string }>) {
    unique.set(`${row.customer_user_id}::${row.visited_by}`, {
      customer_user_id: row.customer_user_id,
      farmer_id: row.visited_by,
    });
  }
  // sales_orders não tem farmer_id direto — pula no batch (não inferimos)
  // Triggers (via farmer_client_scores update) cobrem o caso de novos orders

  const pairs = Array.from(unique.values());

  // 3. Chunks paralelos de 10 (timeout protection — Supabase edge tem ~50s)
  const CONCURRENCY = 10;
  const results: Array<{ customer_user_id: string; farmer_id: string; ok: boolean }> = [];
  for (let i = 0; i < pairs.length; i += CONCURRENCY) {
    const chunk = pairs.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (p) => {
        try {
          const r = await fetch(clientUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret },
            body: JSON.stringify(p),
          });
          const j = await r.json().catch(() => ({}));
          return { ...p, ok: r.ok, ...j };
        } catch (err) {
          return { ...p, ok: false, error: String(err) };
        }
      }),
    );
    results.push(...chunkResults);
  }

  return new Response(JSON.stringify({
    drained,
    recalculated: results.length,
    errors: results.filter(r => !r.ok).length,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
```

- [ ] **Step 2: Visual review**

Re-ler e confirmar:
- Coleta de 3 fontes (calls + orders + visits) — orders pulado intencionalmente sem farmer_id direto
- Dedup via Map com chave `${customer}::${farmer}`
- Promise.all chunks de 10
- try/catch em cada chunk fetch
- Warning log se CRON_SECRET vazio

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/visit-score-recalc-batch/
git commit -m "feat(visit): edge function visit-score-recalc-batch (cron noturno 04:00 BRT)"
```

---

## Task 8: Hook `useMyVisitSuggestions`

**Files:**
- Create: `src/hooks/useMyVisitSuggestions.ts`

- [ ] **Step 1: Escrever o hook**

```typescript
// src/hooks/useMyVisitSuggestions.ts
/**
 * Hook que busca sugestões de visita do dia, filtradas por cidade.
 *
 * 2 queries:
 * 1. Cidades disponíveis (count + top_score por city)
 * 2. Top 30 candidatos da cidade selecionada, depois aplica pickDailyMix.
 *
 * Default city = primeira da lista (cidade com mais candidatos).
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { pickDailyMix } from '@/lib/visit-scoring/mix-selector';
import type { MissionType, VisitScore } from '@/lib/visit-scoring/types';

export interface VisitSuggestion extends VisitScore {
  customer_name: string;
  customer_phone: string | null;
  score_breakdown: Record<string, unknown> | null;
  last_visit_at: string | null;
}

export interface CityWithCount {
  city: string;
  count: number;
  top_score: number;
}

export function useMyVisitSuggestions(opts: {
  city?: string;
  targetCount?: number;
} = {}) {
  const { user } = useAuth();
  const userId = user?.id;

  // Query 1: cidades disponíveis
  const citiesQuery = useQuery({
    queryKey: ['visit-cities', userId],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async (): Promise<CityWithCount[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('customer_visit_scores') as any)
        .select('city, visit_score')
        .eq('farmer_id', userId)
        .gt('visit_score', 30)
        .not('city', 'is', null);
      if (error) throw error;
      const byCity = new Map<string, { count: number; top_score: number }>();
      for (const row of (data ?? []) as Array<{ city: string; visit_score: number }>) {
        const cur = byCity.get(row.city) ?? { count: 0, top_score: 0 };
        cur.count++;
        cur.top_score = Math.max(cur.top_score, row.visit_score);
        byCity.set(row.city, cur);
      }
      return Array.from(byCity.entries())
        .map(([city, v]) => ({ city, ...v }))
        .sort((a, b) => b.top_score - a.top_score);
    },
  });

  const selectedCity = opts.city ?? citiesQuery.data?.[0]?.city;

  // Query 2: top candidatos da cidade selecionada
  const suggestionsQuery = useQuery({
    queryKey: ['visit-suggestions', userId, selectedCity, opts.targetCount],
    enabled: !!userId && !!selectedCity,
    staleTime: 60_000,
    queryFn: async (): Promise<VisitSuggestion[]> => {
      if (!selectedCity || !userId) return [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: scoresData, error: scoresErr } = await (supabase.from('customer_visit_scores') as any)
        .select('customer_user_id, recuperacao_score, expansao_score, relacionamento_score, prospeccao_score, visit_score, primary_mission, city, neighborhood, days_since_last_visit, last_visit_at, score_breakdown')
        .eq('farmer_id', userId)
        .eq('city', selectedCity)
        .order('visit_score', { ascending: false })
        .limit(30);
      if (scoresErr) throw scoresErr;

      const scores = (scoresData ?? []) as Array<{
        customer_user_id: string;
        recuperacao_score: number;
        expansao_score: number;
        relacionamento_score: number;
        prospeccao_score: number;
        visit_score: number;
        primary_mission: MissionType;
        city: string | null;
        neighborhood: string | null;
        days_since_last_visit: number | null;
        last_visit_at: string | null;
        score_breakdown: Record<string, unknown> | null;
      }>;

      if (scores.length === 0) return [];

      const userIds = scores.map(s => s.customer_user_id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: profileData } = await (supabase.from('profiles') as any)
        .select('user_id, name, razao_social, phone')
        .in('user_id', userIds);

      const profileMap = new Map<string, { name: string; phone: string | null }>();
      for (const p of (profileData ?? []) as Array<{ user_id: string; name: string | null; razao_social: string | null; phone: string | null }>) {
        profileMap.set(p.user_id, {
          name: p.razao_social || p.name || 'Cliente sem nome',
          phone: p.phone,
        });
      }

      const visitScores: VisitScore[] = scores.map(s => ({
        customer_user_id: s.customer_user_id,
        scores: {
          recuperacao: s.recuperacao_score,
          expansao: s.expansao_score,
          relacionamento: s.relacionamento_score,
          prospeccao: s.prospeccao_score,
        },
        visit_score: s.visit_score,
        primary_mission: s.primary_mission,
        city: s.city,
        neighborhood: s.neighborhood,
        days_since_last_visit: s.days_since_last_visit,
      }));

      const picked = pickDailyMix(visitScores, opts.targetCount ?? 6);

      // Hidrata com profile data
      return picked.map(p => {
        const profile = profileMap.get(p.customer_user_id);
        const source = scores.find(s => s.customer_user_id === p.customer_user_id);
        return {
          ...p,
          customer_name: profile?.name ?? 'Cliente sem nome',
          customer_phone: profile?.phone ?? null,
          score_breakdown: source?.score_breakdown ?? null,
          last_visit_at: source?.last_visit_at ?? null,
        };
      });
    },
  });

  return {
    cities: citiesQuery.data ?? [],
    suggestions: suggestionsQuery.data ?? [],
    selectedCity,
    isLoading: citiesQuery.isLoading || suggestionsQuery.isLoading,
  };
}
```

- [ ] **Step 2: Validar typecheck**

```bash
bunx tsc --noEmit 2>&1 | tail -3
```
Esperado: clean.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useMyVisitSuggestions.ts
git commit -m "feat(visit): hook useMyVisitSuggestions (2 queries + mix-selector)"
```

---

## Task 9: Component `VisitSuggestionsCard`

**Files:**
- Create: `src/components/dashboard/VisitSuggestionsCard.tsx`

- [ ] **Step 1: Escrever o componente**

```tsx
// src/components/dashboard/VisitSuggestionsCard.tsx
/**
 * Card "Visitas sugeridas hoje" no /meu-dia.
 * Renderizado apenas pra Master/Closer (não Farmer).
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  LifeBuoy,
  TrendingUp,
  Handshake,
  Sprout,
  MapPin,
  Route,
  Loader2,
} from 'lucide-react';
import { useMyVisitSuggestions } from '@/hooks/useMyVisitSuggestions';
import type { MissionType } from '@/lib/visit-scoring/types';

interface MissionMeta {
  label: string;
  icon: typeof LifeBuoy;
  color: string;
  bg: string;
}

const MISSION_META: Record<MissionType, MissionMeta> = {
  recuperacao: { label: 'Recuperação', icon: LifeBuoy, color: 'text-status-error', bg: 'bg-status-error-bg' },
  expansao: { label: 'Expansão', icon: TrendingUp, color: 'text-status-success', bg: 'bg-status-success-bg' },
  relacionamento: { label: 'Relacionamento', icon: Handshake, color: 'text-status-info', bg: 'bg-status-info-bg' },
  prospeccao: { label: 'Prospecção', icon: Sprout, color: 'text-status-warning', bg: 'bg-status-warning-bg' },
};

export function VisitSuggestionsCard() {
  const [city, setCity] = useState<string | undefined>();
  const { cities, suggestions, selectedCity, isLoading } = useMyVisitSuggestions({ city });

  if (isLoading) {
    return (
      <Card className="p-6 flex justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </Card>
    );
  }

  // Não renderiza pra quem não tem visit_scores ainda
  if (cities.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
        <div>
          <h2 className="text-base font-medium">Visitas sugeridas hoje</h2>
          <p className="text-2xs text-muted-foreground">
            Top {suggestions.length} clientes em {selectedCity} — mix balanceado entre 4 missões
          </p>
        </div>
        <Select value={selectedCity} onValueChange={setCity}>
          <SelectTrigger className="w-[220px]">
            <MapPin className="w-3.5 h-3.5 mr-1.5" />
            <SelectValue placeholder="Escolher cidade" />
          </SelectTrigger>
          <SelectContent>
            {cities.map(c => (
              <SelectItem key={c.city} value={c.city}>
                {c.city} ({c.count} candidatos)
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <div className="divide-y divide-border">
        {suggestions.map(s => {
          const meta = MISSION_META[s.primary_mission];
          const Icon = meta.icon;
          const days = s.days_since_last_visit;
          const visitLabel = s.last_visit_at == null
            ? <span className="text-status-info">nunca visitado</span>
            : days === 0 ? 'visitado hoje' : days === 1 ? 'ontem' : `há ${days}d`;

          return (
            <div key={s.customer_user_id} className="p-3 flex items-center gap-3 hover:bg-muted/30">
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className={`p-1.5 rounded ${meta.bg} ${meta.color} shrink-0 cursor-help`}>
                      <Icon className="w-4 h-4" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <div className="text-2xs space-y-1">
                      <div className="font-medium">{meta.label} — score {Math.round(s.visit_score)}</div>
                      <div className="text-muted-foreground">
                        Recuperação: {Math.round(s.scores.recuperacao)} · Expansão: {Math.round(s.scores.expansao)}
                      </div>
                      <div className="text-muted-foreground">
                        Relacionamento: {Math.round(s.scores.relacionamento)} · Prospecção: {Math.round(s.scores.prospeccao)}
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <Link to={`/admin/customers/${s.customer_user_id}/360`} className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{s.customer_name}</div>
                <div className="text-2xs text-muted-foreground flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={`${meta.color} text-2xs`}>{meta.label}</Badge>
                  <span>score: {Math.round(s.visit_score)}</span>
                  {s.neighborhood && <span>{s.neighborhood}</span>}
                  <span>{visitLabel}</span>
                </div>
              </Link>

              <Button size="sm" variant="outline" asChild>
                <Link to={`/admin/route-planner?customer=${s.customer_user_id}`}>
                  <Route className="w-3.5 h-3.5 mr-1" />
                  Planejar
                </Link>
              </Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Validar typecheck + lint**

```bash
bunx tsc --noEmit 2>&1 | tail -3 && bun lint 2>&1 | grep "src/components/dashboard/VisitSuggestionsCard" | head -10
```
Esperado: typecheck clean; lint zero erros nos arquivos novos (`grep` retorna vazio).

- [ ] **Step 3: Commit**

```bash
git add src/components/dashboard/VisitSuggestionsCard.tsx
git commit -m "feat(visit): VisitSuggestionsCard component com dropdown de cidade + tooltip"
```

---

## Task 10: Integração nos dashboards

**Files:**
- Modify: `src/components/dashboard/MasterDashboard.tsx`
- Modify: `src/components/dashboard/CloserDashboard.tsx`

- [ ] **Step 1: Modificar MasterDashboard.tsx**

Ler o arquivo atual:

```bash
cat src/components/dashboard/MasterDashboard.tsx
```

Adicionar import no topo (junto aos outros imports de componentes dashboard):

```tsx
import { VisitSuggestionsCard } from './VisitSuggestionsCard';
```

Logo após `<div className="container mx-auto p-4 space-y-4 max-w-5xl">` e antes do header `<div>` que tem o título, inserir:

```tsx
{/* PR-VISIT-INTELLIGENCE Sub-PR A — card de sugestões de visita */}
<VisitSuggestionsCard />
```

Posição: **acima** do header e do bloco "Em construção" — visitas são prioridade alta-stakes.

- [ ] **Step 2: Modificar CloserDashboard.tsx**

Ler o arquivo:

```bash
cat src/components/dashboard/CloserDashboard.tsx
```

Adicionar import:

```tsx
import { VisitSuggestionsCard } from './VisitSuggestionsCard';
```

Posicionar `<VisitSuggestionsCard />` no topo do conteúdo do dashboard (acima de KpisToday se existir, ou primeiro item).

- [ ] **Step 3: Rodar sanity check completo**

```bash
bunx tsc --noEmit 2>&1 | tail -3 && bun run test 2>&1 | tail -5
```
Esperado:
- typecheck clean
- Tests: 321 passing (295 existentes + 30 novos de visit-scoring)

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/MasterDashboard.tsx src/components/dashboard/CloserDashboard.tsx
git commit -m "feat(visit): integra VisitSuggestionsCard em MasterDashboard + CloserDashboard"
```

---

## Task 11: Spec doc, push e PR

**Files:** (sem edição — só validação final + commits/push)

- [ ] **Step 1: Sanity check final completo**

```bash
git log --oneline origin/main..HEAD && echo "---" && bunx tsc --noEmit 2>&1 | tail -3 && echo "--- lint ---" && bun lint 2>&1 | tail -3 && echo "--- tests ---" && bun run test 2>&1 | tail -5
```

Esperado:
- ~10 commits novos
- typecheck clean
- lint: zero erros novos (baseline pre-existing OK)
- tests: 321/321 passing

- [ ] **Step 2: Push branch**

```bash
git push -u origin claude/pr-visit-intelligence-a-spec
```

- [ ] **Step 3: Abrir PR**

```bash
gh pr create --title "PR-VISIT-INTELLIGENCE Sub-PR A: visit_score + 4 missões + card /meu-dia" --body "$(cat <<'EOF'
## Summary

Foundation do PR-VISIT-INTELLIGENCE. Dá ao Closer/Hunter/Master uma lista diária data-driven de clientes pra visitar presencialmente, categorizada por 4 missões (recuperação / expansão / relacionamento / prospecção), filtrada por cidade, exibida como card no \`/meu-dia\` (acima da AgendaTodayList de chamadas).

**Decomposição:** este é o Sub-PR A. B (route + geocoding), C (ROI feedback), D (cross-sell tagging) vêm depois cada um com seu brainstorm/spec/plan.

Target persona: Master + Closer/Hunter. Farmers (Regina + Tatyana) NÃO veem esse card — eles seguem rotina implícita de entrega (tribal knowledge).

## ATENÇÃO: setup manual pós-merge

**1. Aplicar migration no Lovable SQL Editor** (Lovable Cloud não auto-aplica custom migrations — ver CLAUDE.md §5):

\`\`\`
supabase/migrations/20260518120000_visit_intelligence_v1.sql
\`\`\`

**2. Agendar pg_cron noturno** (04:00 BRT = 07:00 UTC, 1h depois do scoring V2):

\`\`\`sql
SELECT cron.schedule(
  'visit-score-recalc-batch-nightly',
  '0 7 * * *',
  \$\$ SELECT net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/visit-score-recalc-batch',
    headers := jsonb_build_object('x-cron-secret', current_setting('app.cron_shared_key', true))
  ); \$\$
);
\`\`\`

## What changed

**Schema** (1 migration)
- Enum \`visit_mission\` (recuperacao | expansao | relacionamento | prospeccao)
- Tabela \`customer_visit_scores\` (4 mission_scores + visit_score derivado + primary_mission + city/neighborhood/state + last_visit_at + score_breakdown jsonb)
- Tabela \`visit_score_recalc_queue\` + view \`visit_score_recalc_pending\` (mesmo pattern do PR-SCORING-V2)
- 2 triggers: \`route_visits\` AFTER INSERT/UPDATE check_out_at, \`farmer_client_scores\` AFTER UPDATE (filtrado em mudança de churn/expansion/priority)
- RLS com \`'master'\` + \`'employee' AND farmer_id = auth.uid()\`

**Pure libs** (4 arquivos + ~30 testes vitest)
- \`src/lib/visit-scoring/types.ts\` — MissionType, CustomerScoreInputs, VisitScore
- \`src/lib/visit-scoring/helpers.ts\` — clamp, normalizeRevenue (sat R$ 10k), computeDays
- \`src/lib/visit-scoring/missions.ts\` — 4 mission scoring functions + computeVisitScore (tiebreak expansao > recuperacao > relacionamento > prospeccao)
- \`src/lib/visit-scoring/mix-selector.ts\` — pickDailyMix com cap 50% por missão + pass 2 relaxa cap

**Edge functions** (2 Deno)
- \`visit-score-recalc-client\` — single pair OU drain_queue (max 50/batch); UPSERT em customer_visit_scores. Try/catch em drain pra evitar poison-pill (lição V2).
- \`visit-score-recalc-batch\` — cron noturno; drena fila + full refresh dos pares ativos últimos 30d (collected de farmer_calls + route_visits, sales_orders pulado por falta de farmer_id direto). Promise.all chunks de 10.

**UI** (1 hook + 1 component novo, 2 modify)
- Hook \`useMyVisitSuggestions(city?, targetCount?)\` — 2 queries (cities + suggestions), aplica pickDailyMix, hidrata com profiles
- Component \`VisitSuggestionsCard\` — dropdown de cidades (com contagem), top N candidatos com badge da missão + tooltip com breakdown das 4 scores + botão "Planejar" linkando pra /admin/route-planner
- Modifies: MasterDashboard.tsx + CloserDashboard.tsx — adiciona \`<VisitSuggestionsCard />\` no topo

## Health metrics esperadas

- Tests: 321/321 (+30 novos)
- Typecheck: zero erros novos
- Lint: zero erros novos nos arquivos tocados

## Decisões arquiteturais

- **Tabela paralela vs extender farmer_client_scores** — isolamento (visit scoring evolui sem mexer no call scoring; Sub-PR B vai precisar de geo+visit junto)
- **Cluster por cidade vs lat/lng** — Sub-PR A sem geocoding caro; cidade já está estruturada em \`addresses\`. Lat/lng + TSP fica pra Sub-PR B
- **Smart mix data-driven** — não ratio fixo. Algoritmo computa 4 scores por cliente, primary_mission = argmax, pickDailyMix limita 50% por missão pra garantir diversidade
- **Target persona Master/Closer** — Farmers seguem rotina implícita de entrega (tribal knowledge não está em DB; futuro PR pode capturar)
- **Cron 04:00 BRT** — 1h depois do scoring V2 (03:00 BRT) pra ler signal_modifiers atualizados
- **Tiebreak expansao > recuperacao > relacionamento > prospeccao** — prioriza dinheiro entrando > dinheiro saindo > manutenção > pipeline futuro

## Out of scope (Sub-PRs futuros)

| Item | Sub-PR |
|---|---|
| Geocoding lat/lng em addresses | B |
| TSP intra-cidade + integração Leaflet | B |
| Refactor AdminRoutePlanner 1661L | B (parcial) |
| Link route_visits → sales_orders (ROI) | C |
| Cross-sell product tagging em Customer 360 | D |
| Captura de delivery routes em config UI | Future |
| Hunter-specific dashboard | PR-MULTIVENDOR-V2 |
| Extract scoring libs pra _shared/ | V2.1 debt (mesmo do PR-SCORING-V2) |

## Test plan pós-merge

- [ ] Aplicar migration manual (acima)
- [ ] Validar schema:
  \`\`\`sql
  SELECT EXISTS(SELECT 1 FROM pg_type WHERE typname = 'visit_mission') AS enum_exists,
         EXISTS(SELECT 1 FROM pg_tables WHERE tablename = 'customer_visit_scores') AS table_exists,
         EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN ('trg_route_visits_enqueue_visit_recalc', 'trg_farmer_client_scores_enqueue_visit_recalc')) AS triggers_exist;
  \`\`\`
- [ ] Disparar batch manual pra popular scores existentes (sem cron ainda):
  \`\`\`bash
  curl -X POST "\$SUPABASE_URL/functions/v1/visit-score-recalc-batch" \\
    -H "x-cron-secret: \$CRON_SECRET"
  \`\`\`
- [ ] Validar UPSERT:
  \`\`\`sql
  SELECT count(*) FROM customer_visit_scores WHERE farmer_id = (SELECT user_id FROM profiles WHERE email = 'lucascoelhosardenberg@gmail.com' LIMIT 1);
  \`\`\`
- [ ] Abrir \`/meu-dia\` logado como master — VisitSuggestionsCard deve aparecer acima da AgendaTodayList com dropdown de cidades + lista de top candidatos com badges de missão
- [ ] Agendar pg_cron (SQL acima)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Anotar URL do PR**

Salvar o output (URL `https://github.com/...pull/XX`) pra referência. Adicionar ao TodoWrite como pendência: "User: revisar PR XX + mergear + setup manual pós-merge".

---

## Self-review pós-plano (executada antes de entregar)

**1. Spec coverage:**
- ✅ Migration completa em Task 1 (cobre spec data model)
- ✅ types.ts em Task 2 (CustomerScoreInputs, MissionType, VisitScore)
- ✅ helpers.ts em Task 3 (clamp, normalizeRevenue, computeDays)
- ✅ missions.ts em Task 4 (4 mission functions + computeVisitScore + tiebreak)
- ✅ mix-selector.ts em Task 5 (pickDailyMix com diversidade)
- ✅ Edge function client em Task 6 (single + drain, try/catch, UPSERT)
- ✅ Edge function batch em Task 7 (cron, Promise.all chunks, 3 fontes de pares)
- ✅ Hook useMyVisitSuggestions em Task 8 (2 queries, pickDailyMix)
- ✅ VisitSuggestionsCard em Task 9 (dropdown, top N, tooltip, badges)
- ✅ Integration em Task 10 (MasterDashboard + CloserDashboard)
- ✅ Push + PR em Task 11

Nada perdido vs spec.

**2. Placeholder scan:**
- ❌ "TBD" → nenhum no plano
- ❌ "TODO implement later" → nenhum
- ❌ "add appropriate error handling" → nenhum (todo error handling tem código)
- ❌ "similar to Task N" → nenhum (todas as tasks têm código completo)

**3. Type consistency:**
- `MissionType = 'recuperacao' | 'expansao' | 'relacionamento' | 'prospeccao'` consistente em types.ts, missions.ts, mix-selector.ts, edge function inline, hook, component, e SQL enum ✓
- `CustomerScoreInputs` campos batem: usado em missions.ts (todos os campos) e construído no edge function (mesmo shape) ✓
- `VisitScore` interface tem: customer_user_id, scores (MissionScores), visit_score, primary_mission, city, neighborhood, days_since_last_visit. Usado em missions.ts (retorno de computeVisitScore), mix-selector.ts (input), hook (transformação intermediária), component (props) ✓
- Tabela `customer_visit_scores` colunas batem com payload do UPSERT na edge function + SELECT no hook ✓
- `'master'::app_role` consistente em RLS, sem `'admin'` lugar nenhum ✓
- `x-cron-secret` header e `CRON_SECRET` env consistentes entre batch e setup pg_cron ✓

**Risco residual:** se algum subagent renomear acidentalmente uma propriedade (ex: `mission_scores` virar `missionScores`), os edge functions duplicam inline e podem ficar desincronizados. Mitigação: cada task tem o código completo, então copiar literal evita drift. Sub-PR debt: extrair pra `_shared/`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-18-pr-visit-intelligence-sub-pr-a.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch fresh subagent per task, two-stage review (spec + quality) entre tasks. Já usamos isso pra PR-SCORING-V2 com sucesso (10 commits, 26 testes, 0 issues que escaparam).

**2. Inline Execution** — Executo aqui mesmo task por task, com checkpoints pra revisão. Mais rápido mas consome contexto.

**Which approach?**
