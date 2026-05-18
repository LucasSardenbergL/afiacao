// supabase/functions/scoring-recalc-client/index.ts
//
// NOTA SOBRE DUPLICAÇÃO INLINE:
// As funções de scoring (decay, modulators, aggregate) são duplicadas aqui em vez de importadas
// de src/lib/scoring/ porque as Edge Functions Deno rodam em runtime separado e não podem
// cross-importar arquivos de src/. Quando estabilizar, mover para supabase/functions/_shared/scoring/.
// Fonte canônica: src/lib/scoring/{decay,modulators,aggregate,types}.ts
// TODO: PR-SCORING-V2.1 — extrair para _shared/scoring/ e remover duplicação.

import { createClient } from 'npm:@supabase/supabase-js@^2';
import { authorizeCronOrStaff, corsHeaders } from '../_shared/auth.ts';

// --- Inline: decay.ts ---
const HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

function daysBetween(a: Date, b: Date): number {
  return Math.abs(Math.round((b.getTime() - a.getTime()) / MS_PER_DAY));
}

function applyTemporalDecay(weight: number, daysSince: number): number {
  if (daysSince <= 0) return weight;
  return weight * Math.pow(2, -daysSince / HALF_LIFE_DAYS);
}

// --- Inline: types.ts (subset) ---
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

// --- Inline: modulators.ts ---
function modifiersFromEntity(entity: ExtractedEntity, meta: ModifierMeta): SignalModifier[] {
  const baseWeight = Math.max(0, Math.min(1, entity.confidence));
  switch (entity.type) {
    case 'competitor':
      return [{
        dimension: 'churn',
        kind: 'competitor_mentioned',
        delta: 15,
        weight: baseWeight,
        decayedWeight: baseWeight,
        reason: `Concorrente ${entity.value} mencionado`,
        sourceCallId: meta.sourceCallId,
        capturedAt: meta.capturedAt,
        daysSince: meta.daysSince,
      }];
    case 'timeline':
      return [{
        dimension: 'expansion',
        kind: 'desired_outcome',
        delta: 10,
        weight: baseWeight * 0.5,
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
      return [];
    default:
      return [];
  }
}

function modifiersFromAnalysis(analysis: AnalysisSnapshot, meta: ModifierMeta): SignalModifier[] {
  const out: SignalModifier[] = [];
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
  }
  for (const o of analysis.opportunities ?? []) {
    if (o.type === 'upsell' || o.type === 'cross_sell') {
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

// --- Inline: aggregate.ts ---
type ScoreDimension = 'churn' | 'expansion' | 'health' | 'eff';

interface ScoreAdjustment {
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
  computed_at: string;
  source_call_count: number;
}

function aggregateModifiers(modifiers: SignalModifier[], now: Date): ScoreAdjustment {
  const breakdown: ScoreAdjustment['breakdown'] = {
    churn: [],
    expansion: [],
    health: [],
    eff: [],
  };
  const deltas: Record<ScoreDimension, number> = { churn: 0, expansion: 0, health: 0, eff: 0 };
  const uniqueCalls = new Set<string>();

  for (const m of modifiers) {
    const capturedDate = new Date(m.capturedAt);
    const days = daysBetween(capturedDate, now);
    const decayed = applyTemporalDecay(m.weight, days);
    const enriched: SignalModifier = { ...m, daysSince: days, decayedWeight: decayed };
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

// --- Helpers ---
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function jsonError(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// --- Request types ---
interface RecalcRequest {
  customer_user_id?: string;
  farmer_id?: string;
  drain_queue?: boolean;
  max_drain?: number;
}

// --- Core recalc logic ---
async function recalcOne(
  supabase: ReturnType<typeof createClient>,
  customer_user_id: string,
  farmer_id: string,
): Promise<{ ok: boolean; error?: string; adjustment?: ScoreAdjustment }> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data: calls, error: cErr } = await supabase
    .from('farmer_calls')
    .select('id, started_at, entities_extracted, analyses')
    .eq('customer_user_id', customer_user_id)
    .eq('farmer_id', farmer_id)
    .gte('started_at', cutoff);

  if (cErr) return { ok: false, error: `farmer_calls: ${cErr.message}` };

  const now = new Date();
  const allMods: SignalModifier[] = [];

  for (const call of (calls ?? []) as Array<{
    id: string;
    started_at: string;
    entities_extracted: ExtractedEntity[] | null;
    analyses: AnalysisSnapshot[] | null;
  }>) {
    const meta: ModifierMeta = {
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

  const adjustment = aggregateModifiers(allMods, now);

  // Read existing scores to apply delta on top
  const { data: existing } = await supabase
    .from('farmer_client_scores')
    .select('churn_risk, expansion_score, health_score, eff_score, priority_score')
    .eq('customer_user_id', customer_user_id)
    .eq('farmer_id', farmer_id)
    .maybeSingle();

  const base = existing as {
    churn_risk?: number;
    expansion_score?: number;
    health_score?: number;
    eff_score?: number;
  } | null;

  // Clamp boundaries per spec:
  // health_score: 0..1 (different scale)
  // all others: 0..100
  const newChurn    = clamp((base?.churn_risk ?? 0) + adjustment.churn_delta, 0, 100);
  const newExpansion = clamp((base?.expansion_score ?? 0) + adjustment.expansion_delta, 0, 100);
  const newHealth   = clamp((base?.health_score ?? 0) + adjustment.health_delta, 0, 1);
  const newEff      = clamp((base?.eff_score ?? 0) + adjustment.eff_delta, 0, 100);

  // priority_score = newChurn * 0.5 + newExpansion * 0.5 + newEff * 0.3 (clamped 0..100)
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

// --- Main handler ---
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const body: RecalcRequest = await req.json().catch(() => ({}));

  // Mode B: drain queue
  if (body.drain_queue) {
    const max = body.max_drain ?? 50;
    const { data: pending, error: pErr } = await supabase
      .from('score_recalc_pending')
      .select('id, customer_user_id, farmer_id')
      .limit(max);

    if (pErr) return jsonError(`fila: ${pErr.message}`, 500);

    const results = [];
    for (const item of (pending ?? []) as Array<{ id: string; customer_user_id: string; farmer_id: string }>) {
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

  // Mode A: single pair
  if (!body.customer_user_id || !body.farmer_id) {
    return jsonError('customer_user_id e farmer_id obrigatorios (ou drain_queue=true)', 400);
  }

  const r = await recalcOne(supabase, body.customer_user_id, body.farmer_id);
  return new Response(JSON.stringify(r), {
    status: r.error ? 500 : 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
