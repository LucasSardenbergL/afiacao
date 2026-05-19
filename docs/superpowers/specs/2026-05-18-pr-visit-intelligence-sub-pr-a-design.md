# PR-VISIT-INTELLIGENCE — Sub-PR A: Foundation Design Spec

**Date:** 2026-05-18
**Author:** Lucas Sardenberg + Claude (brainstorming session)
**Status:** Approved by user, ready for implementation planning
**Implementation plan:** TBD (next step: `superpowers:writing-plans`)

## Context

Brainstorming session covered the full PR-VISIT-INTELLIGENCE scope. Because the user chose "tudo isso junto" (full scope: ranking + route optimization + ROI feedback), and that scope is too large for a single spec, we decomposed into 3 sub-PRs:

- **Sub-PR A (this spec) — Foundation:** visit_score algorithm + 4 mission categorization + city clustering + card in `/meu-dia`
- **Sub-PR B — Route optimization (future):** lat/lng geocoding + TSP intra-city + map integration + refactor AdminRoutePlanner
- **Sub-PR C — ROI feedback loop (future):** link route_visits → sales_orders + conversion KPIs per mission
- **Sub-PR D — Cross-sell tagging (future):** mark products customer uses but doesn't buy from us + competitor brands tagging in Customer 360 (mentioned by user mid-brainstorming)

This spec covers **only Sub-PR A**. Sub-PRs B/C/D get their own brainstorm + spec when A is in production use.

## Goal

Give the Closer/Hunter/Master (Lucas) a daily, data-driven list of customers worth visiting in person, organized by mission type, scoped to a city of his choice.

**Target user:** Master + Closer/Hunter roles. NOT Farmers (Regina/Tatyana) — they already have an implicit visit routine tied to scheduled delivery routes (calling Monday for Tuesday delivery, etc.), and this scheduling is tribal knowledge not yet in the database.

## Success criteria

1. Lucas opens `/meu-dia`, sees a "Visitas sugeridas hoje" card above the existing call agenda
2. Card defaults to the city with the most candidates, top of dropdown
3. Shows up to 6 customers ranked by visit_score with mission badges (recuperação, expansão, relacionamento, prospecção)
4. Mix is data-driven: each customer's primary mission determined by their highest mission_score; diversity selector caps any single mission at 50% of the day
5. Each entry has "Planejar" button linking to existing AdminRoutePlanner with that customer pre-filtered
6. Score breakdown visible on hover (tooltip with which signals drove it)
7. Auto-recalc: when a route_visit happens OR when farmer_client_scores changes, visit_score gets re-enqueued and updated within ~minutes (via trigger + drain). Nightly cron at 04:00 BRT (1h after PR-SCORING-V2 cron at 03:00 BRT) does full refresh.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  React app                                                          │
│  ┌────────────────┐     ┌──────────────────────┐                    │
│  │  /meu-dia      │     │ VisitSuggestionsCard │                    │
│  │  MasterDash    │────▶│  • City dropdown     │                    │
│  │  CloserDash    │     │  • Top N candidates  │                    │
│  └────────────────┘     │  • Mission badges    │                    │
│                         └──────────┬───────────┘                    │
│                                    │                                │
│                         useMyVisitSuggestions(city?)                │
│                                    │                                │
└────────────────────────────────────┼────────────────────────────────┘
                                     │
                       SELECT customer_visit_scores
                       WHERE farmer_id = me, city = X
                       ORDER BY visit_score DESC
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Postgres                                                           │
│                                                                     │
│  customer_visit_scores  ◀── visit-score-recalc-client (edge)        │
│    (UPSERT 1 row per pair)        ▲                                 │
│                                   │ drains                          │
│  visit_score_recalc_queue ────────┘                                 │
│         ▲                                                           │
│         │ INSERT ON CONFLICT DO NOTHING                             │
│         │                                                           │
│  trg_route_visits_enqueue_visit_recalc                              │
│  trg_farmer_client_scores_enqueue_visit_recalc                      │
│                                                                     │
│  Sources: farmer_client_scores (signal_modifiers from V2)           │
│           route_visits (last_visit_at, lat, lng — geo unused in A)  │
│           sales_orders (count, days_since_last_order)               │
│           addresses (city, neighborhood, state — no lat/lng yet)    │
│           profiles (is_prospect, created_at)                        │
│                                                                     │
│  Cron: visit-score-recalc-batch @ 04:00 BRT (after V2 @ 03:00 BRT)  │
└─────────────────────────────────────────────────────────────────────┘
```

## Decisions (from brainstorm)

| Topic | Decision | Rationale |
|---|---|---|
| Persona alvo | Master + Closer/Hunter only | Farmers seguem rotina implícita de entrega (tribal) |
| Ranking vs call agenda | Diferente — visit_score próprio | Visitas custam 5-10x mais que ligações, intuição diferente |
| UX das 4 missões | Smart mix balanceado | Algoritmo escolhe proporção baseada no perfil de cada cliente |
| Geo strategy | Cluster por cidade (sem geocoding) | Sub-PR A não precisa lat/lng; geocoding pesado fica pra B |
| City selection | Dropdown com contagem de candidatos | User precisa controle (feriados, mudanças de plano) |
| Mix proportion | Data-driven (não ratio fixo) | Score de cada cliente decide sua missão; diversity selector evita dominância de uma só missão (cap 50%) |
| Persistence | Tabela paralela `customer_visit_scores` | Isolation: visit scoring evolui sem perturbar call scoring |
| Refresh trigger | Triggers SQL (route_visits + farmer_client_scores) + cron noturno | Sincronia em quase-real-time + full refresh diário |
| Cron timing | 04:00 BRT (1h depois do V2) | Lê signal_modifiers que V2 acabou de popular |
| Default daily target | 6 visitas | ~1h/visita + 1h deslocamento = ~7h dia |
| Card placement | Acima de AgendaTodayList | Visitas são mais alto-stakes (1h vs 5min) |
| Mission cap | 50% max por missão num dia | Diversity sem perder qualidade |

## Data Model

### Migration `20260518120000_visit_intelligence_v1.sql`

```sql
-- PR-VISIT-INTELLIGENCE Sub-PR A: visit scoring + 4 missões

-- 1. Enum mission type
CREATE TYPE public.visit_mission AS ENUM (
  'recuperacao',
  'expansao',
  'relacionamento',
  'prospeccao'
);

-- 2. Scores table
CREATE TABLE IF NOT EXISTS public.customer_visit_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL,                       -- responsável pela visita (Closer/Hunter/Master)
  
  -- 4 mission scores (0..100)
  recuperacao_score numeric DEFAULT 0,
  expansao_score numeric DEFAULT 0,
  relacionamento_score numeric DEFAULT 0,
  prospeccao_score numeric DEFAULT 0,
  
  -- Derived
  visit_score numeric DEFAULT 0,                  -- MAX(4 above)
  primary_mission visit_mission,                  -- argmax(4 above)
  
  -- Geo (sem lat/lng — só city/neighborhood/state derivados de addresses)
  city text,
  neighborhood text,
  state text,
  
  -- Recency
  last_visit_at timestamptz,
  days_since_last_visit integer,
  
  -- Breakdown for tooltip
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
  reason text NOT NULL,                           -- 'visit_completed'|'score_changed'|'cron'|'manual'
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

-- 4. RLS (usando 'master' — sem 'admin' no enum, lição do PR-SCORING-V2)
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

-- 5. Triggers — enqueue recalc

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

## Algorithm

### 4 mission scoring functions (TypeScript, pure libs)

Location: `src/lib/visit-scoring/missions.ts`

```typescript
function scoreRecuperacao(c: CustomerScoreInputs): number {
  const churnBoost = c.churn_risk * 0.5;                          // 0-50 pts
  const recoverBoost = c.recover_score * 0.3;                     // 0-30 pts
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
  const isProspect = c.sales_orders_count === 0 || c.is_prospect === true;
  if (!isProspect) return 0;
  const baseProspect = 70;
  const recencyOfSignup = c.days_since_signup < 30 ? 20 : 0;
  const signalsQuality = (c.signal_modifiers?.source_call_count ?? 0) > 0 ? 10 : 0;
  return clamp(baseProspect + recencyOfSignup + signalsQuality, 0, 100);
}

function computeVisitScore(c: CustomerScoreInputs): VisitScore {
  const scores = {
    recuperacao: scoreRecuperacao(c),
    expansao: scoreExpansao(c),
    relacionamento: scoreRelacionamento(c),
    prospeccao: scoreProspeccao(c),
  };
  const entries = Object.entries(scores) as Array<[MissionType, number]>;
  // Tiebreak order: expansao > recuperacao > relacionamento > prospeccao
  const ORDER: MissionType[] = ['expansao', 'recuperacao', 'relacionamento', 'prospeccao'];
  const [primary_mission, visit_score] = entries.reduce((max, cur) => {
    if (cur[1] > max[1]) return cur;
    if (cur[1] === max[1] && ORDER.indexOf(cur[0]) < ORDER.indexOf(max[0])) return cur;
    return max;
  });
  return { scores, visit_score, primary_mission };
}
```

### Mix selector

Location: `src/lib/visit-scoring/mix-selector.ts`

```typescript
function pickDailyMix(
  candidates: VisitScore[],
  targetCount = 6,
  maxFractionPerMission = 0.5,
): VisitScore[] {
  const selected: VisitScore[] = [];
  const missionCount: Record<MissionType, number> = {
    recuperacao: 0, expansao: 0, relacionamento: 0, prospeccao: 0,
  };
  const maxPerMission = Math.ceil(targetCount * maxFractionPerMission);

  // Pass 1: respeitando diversidade
  for (const c of candidates) {
    if (selected.length >= targetCount) break;
    if (missionCount[c.primary_mission] >= maxPerMission) continue;
    selected.push(c);
    missionCount[c.primary_mission]++;
  }

  // Pass 2: relaxando se não atingiu target
  if (selected.length < targetCount) {
    for (const c of candidates) {
      if (selected.length >= targetCount) break;
      if (selected.find(s => s.customer_user_id === c.customer_user_id)) continue;
      selected.push(c);
    }
  }

  return selected;
}
```

### Helpers

```typescript
// src/lib/visit-scoring/helpers.ts
function clamp(n: number, min: number, max: number): number;
function normalizeRevenue(value: number): number;  // baseado em percentil 90 dos últimos 180d
function computeDays(timestamp?: string | null): number | null;
```

## Edge Functions

### `supabase/functions/visit-score-recalc-client/index.ts`

Auth: `authorizeCronOrStaff` (interface real `{ok, response}`).

```typescript
interface RecalcRequest {
  customer_user_id?: string;
  farmer_id?: string;
  drain_queue?: boolean;
  max_drain?: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;
  
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const body = await req.json().catch(() => ({}));
  
  if (body.drain_queue) {
    const { data: pending } = await supabase
      .from('visit_score_recalc_pending')
      .select('id, customer_user_id, farmer_id')
      .limit(body.max_drain ?? 50);
    
    for (const item of pending ?? []) {
      let r;
      try {
        r = await recalcOne(supabase, item.customer_user_id, item.farmer_id);
      } catch (err) {
        r = { ok: false, error: `uncaught: ${err}` };
      }
      await supabase.from('visit_score_recalc_queue').update({
        processed_at: new Date().toISOString(),
        error: r.error ?? null,
      }).eq('id', item.id);
    }
    return new Response(JSON.stringify({ drained: pending?.length ?? 0 }));
  }
  
  if (!body.customer_user_id || !body.farmer_id) return jsonError(400);
  const r = await recalcOne(supabase, body.customer_user_id, body.farmer_id);
  return new Response(JSON.stringify(r), { status: r.error ? 500 : 200 });
});

async function recalcOne(supabase, customer_user_id, farmer_id) {
  // 5 queries paralelas pra inputs
  const [scoresRes, visitsRes, ordersRes, addressRes, profileRes] = await Promise.all([
    supabase.from('farmer_client_scores').select('*').eq('customer_user_id', customer_user_id).eq('farmer_id', farmer_id).maybeSingle(),
    supabase.from('route_visits').select('check_in_at').eq('customer_user_id', customer_user_id).order('check_in_at', { ascending: false }).limit(1),
    supabase.from('sales_orders').select('id, created_at').eq('user_id', customer_user_id),
    supabase.from('addresses').select('city, neighborhood, state').eq('user_id', customer_user_id).eq('is_default', true).maybeSingle(),
    supabase.from('profiles').select('created_at, is_prospect').eq('user_id', customer_user_id).maybeSingle(),
  ]);
  
  const inputs = buildInputs(scoresRes.data, visitsRes.data, ordersRes.data, addressRes.data, profileRes.data);
  const result = computeVisitScore(inputs);
  
  await supabase.from('customer_visit_scores').upsert({
    customer_user_id, farmer_id,
    recuperacao_score: result.scores.recuperacao,
    expansao_score: result.scores.expansao,
    relacionamento_score: result.scores.relacionamento,
    prospeccao_score: result.scores.prospeccao,
    visit_score: result.visit_score,
    primary_mission: result.primary_mission,
    city: addressRes.data?.city,
    neighborhood: addressRes.data?.neighborhood,
    state: addressRes.data?.state,
    last_visit_at: visitsRes.data?.[0]?.check_in_at,
    days_since_last_visit: computeDays(visitsRes.data?.[0]?.check_in_at),
    score_breakdown: {
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
        churn_delta: inputs.signal_modifiers?.churn_delta ?? 0,
        expansion_delta: inputs.signal_modifiers?.expansion_delta ?? 0,
      },
      mission_scores: result.scores,
    },
    calculated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'customer_user_id,farmer_id' });
  
  return { ok: true, ...result };
}
```

### `supabase/functions/visit-score-recalc-batch/index.ts`

Cron 04:00 BRT = 07:00 UTC (1h after PR-SCORING-V2 batch).

```typescript
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;
  
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const clientUrl = `${SUPABASE_URL}/functions/v1/visit-score-recalc-client`;
  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';
  if (!cronSecret) console.warn('[visit-score-recalc-batch] CRON_SECRET not set');
  
  // 1. Drain pending queue
  await fetch(clientUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret },
    body: JSON.stringify({ drain_queue: true, max_drain: 500 }),
  });
  
  // 2. Active pairs nos últimos 30d (qualquer farmer_calls OU sales_orders OU route_visits)
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const pairs = await getActivePairs(supabase, cutoff);
  
  // 3. Promise.all chunks de 10 (timeout protection)
  const CONCURRENCY = 10;
  for (let i = 0; i < pairs.length; i += CONCURRENCY) {
    const chunk = pairs.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(p =>
      fetch(clientUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret },
        body: JSON.stringify(p),
      }).catch(err => ({ ok: false, error: String(err) }))
    ));
  }
  
  return new Response(JSON.stringify({ recalculated: pairs.length }));
});
```

### Setup pg_cron (manual pós-merge)

```sql
SELECT cron.schedule(
  'visit-score-recalc-batch-nightly',
  '0 7 * * *',  -- 04:00 BRT = 07:00 UTC
  $$ SELECT net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/visit-score-recalc-batch',
    headers := jsonb_build_object('x-cron-secret', current_setting('app.cron_shared_key', true))
  ); $$
);
```

## UI

### Hook `useMyVisitSuggestions`

`src/hooks/useMyVisitSuggestions.ts` — 2 queries via React Query:

1. **Cidades disponíveis** — agrupa por city, conta candidatos, ordena por top_score
2. **Sugestões da cidade selecionada** — top 30 ordenados, hidrata com profile, aplica `pickDailyMix`

Default city = primeira da lista (cidade com mais candidatos).

### Component `VisitSuggestionsCard`

`src/components/dashboard/VisitSuggestionsCard.tsx`:

- Header: título + descrição + dropdown de cidades (com contagem)
- Lista: top N candidatos (default 6) com:
  - Ícone + cor da missão primária
  - Nome do cliente (link pra `/admin/customers/:id/360`)
  - Badges: label da missão + visit_score + bairro + days since last visit ("nunca visitado" se null)
  - Botão "Planejar" linkando pra `/admin/route-planner?customer=:id`
- Tooltip on hover: `score_breakdown` mostrando inputs (churn_risk, expansion_score, etc) + sumário de signal_modifiers (quantos signals churn/expansion contribuíram) + os 4 mission_scores (pra ver qual ganhou e por que)

### Integration in `/meu-dia`

Modify `MasterDashboard.tsx` and `CloserDashboard.tsx` (when implemented):

```tsx
<VisitSuggestionsCard />  // NEW — acima
<AgendaTodayList />       // existente — fica abaixo
```

Not rendered in `FarmerDashboardV2` (Regina/Tatyana don't need it — they follow delivery routine).

## Testing strategy

| Camada | Estratégia | Cobertura esperada |
|---|---|---|
| Libs puras (`src/lib/visit-scoring/`) | TDD vitest | ~30 testes |
| Edge functions | Smoke test manual via curl pós-deploy | 0 unit tests Deno (custo alto, libs já cobertas) |
| Hooks | Validação por TypeScript + smoke UI | 0 unit tests |
| UI | Visual smoke + screenshot review | 0 e2e em MVP |

### Test cases por arquivo

**`missions.test.ts`** (~15 testes)

```typescript
describe('scoreRecuperacao', () => {
  it('cliente VIP que parou há 90d com churn alto → score > 70');
  it('cliente sempre comprou pouco com churn alto → score baixo');
  it('cliente que comprou ontem → score = 0');
  it('signal modifiers de churn boost o score em até 10 pts');
});
describe('scoreExpansao', () => {
  it('cliente com expansion_score=80 + signal upsell → score > 70');
  it('cliente em churn → expansão = 0 (mesmo com expansion_score)');
  it('cliente sem upsell signal mas com expansion_score=50 → score médio');
});
describe('scoreRelacionamento', () => {
  it('cliente health=1.0, revenue alto, sem visita 120d → score alto');
  it('cliente em risco (churn=80) → relacionamento penalizado');
  it('cliente novo (days_since_visit null) → score moderado');
});
describe('scoreProspeccao', () => {
  it('cliente com 0 sales_orders → score base 70');
  it('is_prospect=true com signup recente → score = 90');
  it('cliente com sales_orders > 0 → score = 0');
});
describe('computeVisitScore', () => {
  it('retorna max dos 4 + mission correspondente');
  it('empate vai pra ordem: expansao > recuperacao > relacionamento > prospeccao');
});
```

**`mix-selector.test.ts`** (~6 testes)

```typescript
describe('pickDailyMix', () => {
  it('respeita maxFractionPerMission (não passa 50% de uma missão)');
  it('relaxa cap se não conseguir preencher target');
  it('preserva ordem de visit_score dentro de cada missão');
  it('lista vazia → array vazio');
  it('target maior que candidatos → retorna todos');
  it('garante diversidade mesmo com top dominado por uma missão');
});
```

**`helpers.test.ts`** (~9 testes)

```typescript
describe('clamp', () => { /* 3 cases */ });
describe('normalizeRevenue', () => { /* 3 cases (0, average, top10%) */ });
describe('computeDays', () => { /* 3 cases (null, today, 30 days ago) */ });
```

## Out of scope

| Item | Where it goes |
|---|---|
| Geocoding lat/lng em addresses | Sub-PR B |
| TSP routing intra-cidade | Sub-PR B |
| Integração Leaflet no card | Sub-PR B |
| Refactor AdminRoutePlanner (1661L god component) em subcomponentes | Sub-PR B (parcial) |
| Link route_visits → sales_orders pra ROI | Sub-PR C |
| KPI dashboard de visitas que valeram a pena | Sub-PR C |
| Cross-sell product tagging em Customer 360 | Sub-PR D |
| Captura de delivery routes em config UI | Sub-PR de Farmer-routing futuro |
| Holiday/exception handling automático | Sub-PR B ou config separado |
| UI de tunning de pesos (`farmer_learning_weights`) | Sub-PR de tunning futuro |
| Hunter-specific dashboard | PR-MULTIVENDOR-V2 (já no backlog) |
| Extract scoring libs pra `supabase/functions/_shared/` | V2.1 debt (compartilhado com PR-SCORING-V2) |

## File structure summary

```
Create:
- supabase/migrations/20260518xxxxxx_visit_intelligence_v1.sql  (~150 LoC)
- src/lib/visit-scoring/types.ts                                  (~50 LoC)
- src/lib/visit-scoring/missions.ts                               (~120 LoC)
- src/lib/visit-scoring/mix-selector.ts                           (~40 LoC)
- src/lib/visit-scoring/helpers.ts                                (~30 LoC)
- src/lib/visit-scoring/__tests__/missions.test.ts                (~250 LoC)
- src/lib/visit-scoring/__tests__/mix-selector.test.ts            (~120 LoC)
- src/lib/visit-scoring/__tests__/helpers.test.ts                 (~80 LoC)
- supabase/functions/visit-score-recalc-client/index.ts           (~350 LoC, libs duplicadas inline)
- supabase/functions/visit-score-recalc-batch/index.ts            (~110 LoC)
- src/hooks/useMyVisitSuggestions.ts                              (~100 LoC)
- src/components/dashboard/VisitSuggestionsCard.tsx               (~120 LoC)

Modify:
- src/components/dashboard/MasterDashboard.tsx                    (+ VisitSuggestionsCard import)
- src/components/dashboard/CloserDashboard.tsx                    (+ VisitSuggestionsCard, quando implementado)

Total estimate: ~1500 LoC (similar a PR-SCORING-V2)
```

## Open questions

None after brainstorm. All foundational decisions made.

Future brainstorms (Sub-PR B/C/D) will surface their own questions when they start.

## Approval

User approved each design section during brainstorm:
- Data Model ✅
- Algorithm ✅
- Edge Functions ✅
- UI ✅
- Testing + Out-of-scope ✅

Next step: spec self-review → user review → invoke `superpowers:writing-plans` to generate implementation plan.
