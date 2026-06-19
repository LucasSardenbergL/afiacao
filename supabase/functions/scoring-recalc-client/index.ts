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

// --- Inline: src/lib/sinais/schema.ts (réplica fiel — Deno não importa de src/) ---
// FONTE DA VERDADE: src/lib/sinais/{schema,converter}.ts (vitest 10/10). Os números abaixo
// (PROB_MIN, deltas) DEVEM bater com o oráculo. Não inventar.
const PROB_MIN = 0.6;
const DELTA_PRECO_CONCORRENTE = 20; // concorrente mais barato = risco de churn
const DELTA_MARCA_CONCORRENTE = 15; // espelha competitor_mentioned do scoring legado
const DELTA_DEMANDA_NOVA = 10; // sinal de expansão

interface SinaisPreco {
  tipo: 'cliente_paga' | 'concorrente_cobra';
  produto: string | null;
  valor: number | null;
  moeda: string | null;
  unidade_base: string | null;
  concorrente: string | null;
  speaker_is_customer: boolean;
  confianca: number;
  evidencia: string;
}
interface SinaisMarcaEmUso {
  marca: string;
  produto: string | null;
  e_concorrente: boolean | null;
  speaker_is_customer: boolean;
  confianca: number;
  evidencia: string;
}
interface SinaisDemandaNova {
  descricao: string;
  contexto: string | null;
  urgencia: string | null;
  recorrente: boolean | null;
  confianca: number;
  evidencia: string;
}
interface SinaisLigacao {
  precos: SinaisPreco[];
  marcas_em_uso: SinaisMarcaEmUso[];
  produtos_gap: unknown[]; // produto-gap NÃO pontua (Fatia 3) — fora do conversor
  demandas_novas: SinaisDemandaNova[];
  houve_sinal: boolean;
}
// Envelope persistido por extrair-sinais-ligacao (1 writer). status='extraido' (sem acento).
interface SinaisEnvelope {
  status?: string;
  sinais?: SinaisLigacao;
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
  // FA4 (shadow-mode): toda modifier carimba a classe de sinal para o filtro uniforme da Fase C.
  // 'preco'|'marca'|'demanda' vêm do oráculo (sinais pós-call); o legado é mapeado para a classe
  // coerente em modifiersFromEntity/Analysis (competitor→marca, timeline/risk/outcome→demanda, upsell→preco).
  class?: 'preco' | 'marca' | 'demanda';
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
        class: 'marca', // FA4: concorrente mencionado ≈ sinal de marca
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
        class: 'demanda', // FA4: prazo/desired_outcome ≈ sinal de demanda
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
        class: 'demanda', // FA4: risco alto (legado) — classe coerente p/ filtro uniforme
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
        class: 'preco', // FA4: upsell/cross-sell (legado) — classe coerente p/ filtro uniforme
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

// --- Inline: src/lib/sinais/converter.ts (réplica fiel — vitest 10/10 é o oráculo) ---
// Converte os sinais pós-call (envelope.sinais) em SignalModifier[] com a MESMA lógica de
// sinaisParaModifiers: precisão > recall, ausente ≠ zero, nunca fabrica. weight=confianca;
// decayedWeight inicia = weight (o decay temporal é aplicado depois em aggregateModifiers).
function modifiersFromSinais(envelope: SinaisEnvelope | null | undefined, meta: ModifierMeta): SignalModifier[] {
  if (envelope?.status !== 'extraido') return [];
  const s = envelope.sinais;
  if (!s || !s.houve_sinal) return []; // houve_sinal=false → [] (não fabrica)
  const out: SignalModifier[] = [];

  // PREÇO — contrato estrito: só concorrente mais barato, dito pelo CLIENTE, unidade comparável, confiante.
  for (const p of s.precos ?? []) {
    const comparavel =
      p.tipo === 'concorrente_cobra' &&
      p.speaker_is_customer &&
      p.produto != null &&
      p.valor != null &&
      p.moeda != null &&
      p.unidade_base != null &&
      p.confianca >= PROB_MIN;
    if (!comparavel) continue;
    out.push({
      dimension: 'churn',
      kind: 'preco_concorrente_menor',
      delta: DELTA_PRECO_CONCORRENTE,
      weight: p.confianca,
      decayedWeight: p.confianca,
      reason: `Concorrente ${p.concorrente ?? '?'} cobra ${p.valor} ${p.moeda}/${p.unidade_base} em ${p.produto}`,
      sourceCallId: meta.sourceCallId,
      capturedAt: meta.capturedAt,
      daysSince: meta.daysSince,
      class: 'preco',
    });
  }

  // MARCA — concorrente em uso, dito pelo cliente.
  for (const m of s.marcas_em_uso ?? []) {
    if (!(m.e_concorrente && m.speaker_is_customer && m.confianca >= PROB_MIN)) continue;
    out.push({
      dimension: 'churn',
      kind: 'marca_concorrente_em_uso',
      delta: DELTA_MARCA_CONCORRENTE,
      weight: m.confianca,
      decayedWeight: m.confianca,
      reason: `Cliente usa ${m.marca}`,
      sourceCallId: meta.sourceCallId,
      capturedAt: meta.capturedAt,
      daysSince: meta.daysSince,
      class: 'marca',
    });
  }

  // DEMANDA NOVA — expansão.
  for (const d of s.demandas_novas ?? []) {
    if (d.confianca < PROB_MIN) continue;
    out.push({
      dimension: 'expansion',
      kind: 'demanda_nova',
      delta: DELTA_DEMANDA_NOVA,
      weight: d.confianca,
      decayedWeight: d.confianca,
      reason: `Demanda: ${d.descricao}`,
      sourceCallId: meta.sourceCallId,
      capturedAt: meta.capturedAt,
      daysSince: meta.daysSince,
      class: 'demanda',
    });
  }

  // PRODUTO-GAP — não pontua (consumo = Fatia 3). Persistido no envelope, fora daqui.
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
function jsonError(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// --- Request types ---
interface RecalcRequest {
  customer_user_id?: string;
  farmer_id?: string;   // aceito mas IGNORADO (B2c): o batch ainda envia no body; recalcOne não usa mais
  drain_queue?: boolean;
  max_drain?: number;
}

// --- Core recalc logic ---
async function recalcOne(
  supabase: ReturnType<typeof createClient>,
  customer_user_id: string,
): Promise<{ ok: boolean; error?: string; adjustment?: ScoreAdjustment; skipped?: boolean }> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  // Safety cap: 200 calls in 30 days = ~7/day average. Beyond that, decay already
  // makes older calls negligible. Order by most-recent first so the cap drops
  // the lowest-weight calls.
  // Anti-ressurreição (fornecedores fora da carteira): cliente marcado p/ exclusão
  // (cliente_classificacao.excluir_da_carteira) não recebe score. Checagem em paralelo
  // com as calls → zero latência extra. Ausência de linha = não-fornecedor = segue (fail-safe).
  const [flagRes, callsRes] = await Promise.all([
    supabase.from('cliente_classificacao').select('user_id')
      .eq('user_id', customer_user_id).eq('excluir_da_carteira', true).maybeSingle(),
    // P1 (Opção A): os sinais são do CLIENTE — contam independentemente de QUEM ligou.
    // Filtrar por farmer_id descartava SILENCIOSAMENTE calls de não-donos (cobertura/gestor),
    // subcontando o score do cliente. Escopo é o cliente (farmer_calls não tem company_id).
    supabase
      .from('farmer_calls')
      .select('id, started_at, entities_extracted, analyses, sinais_ligacao')
      .eq('customer_user_id', customer_user_id)
      .gte('started_at', cutoff)
      .order('started_at', { ascending: false })
      .limit(200),
  ]);

  // FAIL-CLOSED (Codex P1): erro ao ler a flag → NÃO recalcula (senão um erro transitório
  // de leitura recriaria score de fornecedor). O cliente é re-enfileirado no próximo batch.
  if (flagRes.error) return { ok: false, error: `cliente_classificacao: ${flagRes.error.message}` };
  if (flagRes.data) return { ok: true };
  const { data: calls, error: cErr } = callsRes;
  if (cErr) return { ok: false, error: `farmer_calls: ${cErr.message}` };

  const now = new Date();
  const allMods: SignalModifier[] = [];

  for (const call of (calls ?? []) as Array<{
    id: string;
    started_at: string;
    entities_extracted: ExtractedEntity[] | null;
    analyses: AnalysisSnapshot[] | null;
    sinais_ligacao: SinaisEnvelope | null;
  }>) {
    const meta: ModifierMeta = {
      sourceCallId: call.id,
      capturedAt: call.started_at,
      daysSince: daysBetween(new Date(call.started_at), now),
    };

    // FA4 — anti-dupla-contagem: a pós-call (sinais_ligacao, status='extraido') é a FONTE DA VERDADE.
    // Quando ela existe, ela SUBSTITUI os conversores legados (entities_extracted/analyses) desta call,
    // senão somaríamos o mesmo sinal duas vezes (ex.: concorrente vira tanto competitor_mentioned quanto
    // marca_concorrente_em_uso). Calls antigas sem extração caem no caminho legado (com class carimbada).
    if (call.sinais_ligacao?.status === 'extraido') {
      allMods.push(...modifiersFromSinais(call.sinais_ligacao, meta));
      continue;
    }

    for (const e of call.entities_extracted ?? []) {
      allMods.push(...modifiersFromEntity(e, meta));
    }
    for (const a of call.analyses ?? []) {
      allMods.push(...modifiersFromAnalysis(a, meta));
    }
  }

  const adjustment = aggregateModifiers(allMods, now);

  // PR-SCORING-V2.1 (fix idempotência): gravar SÓ signal_modifiers.
  //
  // ANTES: lia churn_risk/expansion_score/eff_score/health_score atuais e
  // gravava base + delta de volta nas MESMAS colunas. Isso causava:
  //   1. compounding — o recalc lia o próprio output da run anterior e somava
  //      o mesmo delta de novo (expansion_score/eff_score nunca eram resetados
  //      pelo calculate-scores → inflavam até o clamp);
  //   2. corrupção de health_score — clampava 0..1 sobre dado que é 0..100;
  //   3. briga de fórmulas — sobrescrevia priority_score (do calculate-scores,
  //      rico: margin/churn/repurchase/goal) por uma fórmula mais pobre.
  //
  // AGORA: signal_modifiers (jsonb) é função PURA das calls dos últimos 30d →
  // idempotente. As colunas-base continuam de propriedade do calculate-scores.
  // A prioridade efetiva (base + nudge dos sinais) é computada em read-time
  // (src/lib/scoring/agenda.ts → signalPriorityNudge / effectivePriority).
  // Opção A (carteira-Omie): 1 linha por cliente. B2c: recalcOne NÃO grava mais farmer_id.
  // A posse é do trigger trg_carteira_reconcile_score_owner (reatribuição), do seed do
  // calculate-scores e do reconcile one-time. Antes, gravar o farmer_id do payload da fila
  // podia RE-STALAR um cliente reatribuído (a fila carrega o dono resolvido no ENQUEUE,
  // anterior à troca; drenada depois, re-escrevia o dono antigo). recalcOne localiza a linha
  // por customer_user_id e só atualiza os signal_modifiers (sua propriedade).
  // F1 (reset-path robusto): UPDATE-only, NÃO upsert. Antes o upsert criava uma linha
  // ESPARSA (só signal_modifiers; campos-base no DEFAULT → days_since_last_purchase=0 →
  // recência=100 fabricada) quando o cliente ainda não fora semeado — e bastava 1 dessas
  // linhas p/ suprimir o seed inteiro do calculate-scores num reset (gate length===0).
  // Agora: 0 linhas afetadas = cliente ainda não semeado → PULA (não fabrica). O
  // calculate-scores semeia o faltante (≤24h, dado real) e o batch noturno
  // (scoring-recalc-batch re-recalcula todos os 30d-ativos) reaplica os signal_modifiers.
  const { data: updated, error: uErr } = await supabase
    .from('farmer_client_scores')
    .update({
      signal_modifiers: adjustment,
      last_signal_recalc_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('customer_user_id', customer_user_id)
    .select('id');

  if (uErr) return { ok: false, error: `update: ${uErr.message}` };
  if (!updated || updated.length === 0) return { ok: true, skipped: true };

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
      .select('id, customer_user_id')
      .limit(max);

    if (pErr) return jsonError(`fila: ${pErr.message}`, 500);

    // Drain CONCORRENTE (codex 2026-05-24): o backfill da carteira passa pela fila,
    // então o dreno precisa caber no timeout de 50s. Chunks de 10 (cada recalcOne = 1 query
    // + 1 upsert). max_drain ~500 fica seguro.
    const queue = (pending ?? []) as Array<{ id: string; customer_user_id: string }>;
    const CONCURRENCY = 10;
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (let i = 0; i < queue.length; i += CONCURRENCY) {
      const chunk = queue.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(chunk.map(async (item) => {
        let r: { ok: boolean; error?: string; adjustment?: ScoreAdjustment };
        try {
          r = await recalcOne(supabase, item.customer_user_id);
        } catch (err) {
          r = { ok: false, error: `uncaught: ${err instanceof Error ? err.message : String(err)}` };
        }
        // Always mark processed, even on uncaught throw — prevents poison-pill rows from being retried forever.
        await supabase.from('score_recalc_queue').update({
          processed_at: new Date().toISOString(),
          error: r.error ?? null,
        }).eq('id', item.id);
        return { id: item.id, ok: r.ok, error: r.error };
      }));
      results.push(...chunkResults);
    }

    return new Response(JSON.stringify({ drained: results.length, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Mode A: single client (B2c: farmer_id não é mais necessário — recalcOne não grava posse)
  if (!body.customer_user_id) {
    return jsonError('customer_user_id obrigatorio (ou drain_queue=true)', 400);
  }

  const r = await recalcOne(supabase, body.customer_user_id);
  return new Response(JSON.stringify(r), {
    status: r.error ? 500 : 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
