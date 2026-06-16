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
// --- Inline helpers ---
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
  const signalsBoost = (c.signal_modifiers?.breakdown?.churn ?? [])
    .reduce((s, m) => s + m.delta * m.decayedWeight, 0) * 0.1;
  return clamp(churnBoost + recoverBoost + recencyPenalty + signalsBoost, 0, 100);
}

function scoreExpansao(c: CustomerScoreInputs): number {
  const expansionBase = c.expansion_score * 0.6;
  const revenueBoost = normalizeRevenue(c.revenue_potential) * 20;
  const signalsBoost = (c.signal_modifiers?.breakdown?.expansion ?? [])
    .reduce((s, m) => s + m.delta * m.decayedWeight, 0) * 0.2;
  return clamp(expansionBase + revenueBoost + signalsBoost, 0, 100);
}

function scoreRelacionamento(c: CustomerScoreInputs): number {
  // health_score é 0..100 (calculate-scores). * 0.5 → contribuição 0..50.
  const healthBoost = c.health_score * 0.5;
  const revenueBoost = normalizeRevenue(c.avg_monthly_spend_180d) * 30;
  // ?? 30 (não 365) — null = sem histórico de visita = sem relacionamento estabelecido.
  // Mesma decisão de src/lib/visit-scoring/missions.ts.
  const daysSinceVisitBoost = Math.min(40, (c.days_since_last_visit ?? 30) * 0.3);
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
// --- IO helpers ---
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
  const [flagRes, scoresRes, visitsRes, ordersRes, addressRes, profileRes] = await Promise.all([
    // Anti-ressurreição (fornecedores fora da carteira): cliente marcado p/ exclusão não recebe
    // visit score. Checagem na mesma rodada paralela → zero latência extra. Ausência = segue.
    supabase.from('cliente_classificacao').select('user_id').eq('user_id', customer_user_id).eq('excluir_da_carteira', true).maybeSingle(),
    // Opção A (carteira-Omie): 1 linha de score por cliente → lê por customer_user_id só.
    supabase.from('farmer_client_scores').select('churn_risk, expansion_score, health_score, recover_score, revenue_potential, avg_monthly_spend_180d, days_since_last_purchase, signal_modifiers').eq('customer_user_id', customer_user_id).maybeSingle(),
    supabase.from('route_visits').select('check_in_at').eq('customer_user_id', customer_user_id).order('check_in_at', { ascending: false }).limit(1),
    supabase.from('sales_orders').select('id').eq('customer_user_id', customer_user_id),
    supabase.from('addresses').select('city, neighborhood, state').eq('user_id', customer_user_id).eq('is_default', true).maybeSingle(),
    supabase.from('profiles').select('created_at, is_prospect').eq('user_id', customer_user_id).maybeSingle(),
  ]);

  // FAIL-CLOSED (Codex P1): erro ao ler a flag → NÃO recalcula (não recria score de fornecedor
  // por erro transitório). Re-enfileirado no próximo batch.
  if (flagRes.error) return { ok: false, error: `cliente_classificacao: ${flagRes.error.message}` };
  if (flagRes.data) return { ok: true };
  if (scoresRes.error) return { ok: false, error: `farmer_client_scores: ${scoresRes.error.message}` };

  const scores = (scoresRes.data ?? {}) as Record<string, unknown>;
  const lastVisitAt = (visitsRes.data ?? [])[0]?.check_in_at ?? null;
  const salesOrdersCount = (ordersRes.data ?? []).length;
  const address = (addressRes.data ?? {}) as Record<string, unknown>;
  const profile = (profileRes.data ?? {}) as Record<string, unknown>;

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
    is_prospect: Boolean(profile.is_prospect ?? false),
    days_since_signup: computeDays(profile.created_at as string) ?? 999,
    city: (address.city as string) ?? null,
    neighborhood: (address.neighborhood as string) ?? null,
    state: (address.state as string) ?? null,
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
      churn_count: inputs.signal_modifiers?.breakdown?.churn?.length ?? 0,
      expansion_count: inputs.signal_modifiers?.breakdown?.expansion?.length ?? 0,
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
  }, { onConflict: 'customer_user_id' });

  if (upsertErr) return { ok: false, error: `upsert: ${upsertErr.message}` };

  return { ok: true, visit_score: result.visit_score, primary_mission: result.primary_mission };
}

// =====================================================
// --- Main handler ---
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

  // Drain mode
  if (body.drain_queue) {
    const { data: pending, error } = await supabase
      .from('visit_score_recalc_pending')
      .select('id, customer_user_id, farmer_id')
      .limit(body.max_drain ?? 50);
    if (error) return jsonError(`pending: ${error.message}`, 500);

    // Drain CONCORRENTE (codex 2026-05-24): o backfill da carteira inteira passa pela fila.
    // recalcOne faz 5 queries/cliente, então o dreno sequencial estouraria 50s em lotes grandes.
    // Chunks de 10 → ~50 queries em voo; max_drain ~500 cabe no timeout.
    const queue = (pending ?? []) as Array<{ id: string; customer_user_id: string; farmer_id: string }>;
    const CONCURRENCY = 10;
    const results: Array<{ id: string; ok: boolean; error?: string; visit_score?: number; primary_mission?: MissionType }> = [];
    for (let i = 0; i < queue.length; i += CONCURRENCY) {
      const chunk = queue.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(chunk.map(async (item) => {
        let r: { ok: boolean; error?: string; visit_score?: number; primary_mission?: MissionType };
        try {
          r = await recalcOne(supabase, item.customer_user_id, item.farmer_id);
        } catch (err) {
          r = { ok: false, error: `uncaught: ${err instanceof Error ? err.message : String(err)}` };
        }
        // Always mark processed (even on uncaught error) — avoids poison-pill
        await supabase.from('visit_score_recalc_queue').update({
          processed_at: new Date().toISOString(),
          error: r.error ?? null,
        }).eq('id', item.id);
        return { id: item.id, ...r };
      }));
      results.push(...chunkResults);
    }

    return new Response(JSON.stringify({ drained: results.length, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Single mode
  if (!body.customer_user_id || !body.farmer_id) {
    return jsonError('customer_user_id e farmer_id obrigatorios (ou drain_queue=true)', 400);
  }

  const r = await recalcOne(supabase, body.customer_user_id, body.farmer_id);
  return new Response(JSON.stringify(r), {
    status: r.error ? 500 : 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
