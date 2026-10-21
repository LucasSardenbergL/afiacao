// Borda do jsonb `farmer_client_scores.signal_modifiers`. O tipo dizia `ScoreAdjustment | null`, mas
// em 2026-10-20 os 6.633 scores da prod têm `{}` (nenhum ajuste gravado). Aqui: NULL ou `{}` = sem
// ajuste (null); objeto com conteúdo é lido por forma e, se PARCIAL ou com tipo trocado, LANÇA — um
// ajuste pela metade não pode virar delta 0 em silêncio.
import type { Json } from '@/integrations/supabase/types';
import { listaJson, numeroJson, objetoJson, textoJson, type ObjetoJson } from '@/lib/json-forma';
import type { ScoreAdjustment, ScoreDimension, SignalModifier } from './types';

const FONTE = 'farmer_client_scores.signal_modifiers';
const DIMENSOES: readonly ScoreDimension[] = ['churn', 'expansion', 'health', 'eff'];
const TIPOS: readonly SignalModifier['kind'][] = [
  'competitor_mentioned', 'price_objection_high', 'desired_outcome',
  'opportunity_upsell', 'risk_high', 'close_attempted_no_close',
];

function doVocabulario<T extends string>(lista: readonly T[], o: ObjetoJson, chave: string): T {
  const v = textoJson(o, chave, FONTE);
  const achado = lista.find((x) => x === v);
  if (!achado) throw new Error(`${FONTE}: "${chave}" fora do vocabulário (${v})`);
  return achado;
}

function modificadorDoJson(v: Json): SignalModifier {
  const o = objetoJson(v, `${FONTE}.breakdown`);
  return {
    dimension: doVocabulario(DIMENSOES, o, 'dimension'),
    kind: doVocabulario(TIPOS, o, 'kind'),
    delta: numeroJson(o, 'delta', FONTE),
    weight: numeroJson(o, 'weight', FONTE),
    decayedWeight: numeroJson(o, 'decayedWeight', FONTE),
    reason: textoJson(o, 'reason', FONTE),
    sourceCallId: textoJson(o, 'sourceCallId', FONTE),
    capturedAt: textoJson(o, 'capturedAt', FONTE),
    daysSince: numeroJson(o, 'daysSince', FONTE),
  };
}

export function ajusteDoJson(v: Json | null): ScoreAdjustment | null {
  if (v === null) return null;
  const o = objetoJson(v, FONTE);
  if (Object.keys(o).length === 0) return null;
  const b = objetoJson(o.breakdown, `${FONTE}.breakdown`);
  const lista = (d: ScoreDimension) => listaJson(b[d], `${FONTE}.breakdown.${d}`).map(modificadorDoJson);
  return {
    churn_delta: numeroJson(o, 'churn_delta', FONTE),
    expansion_delta: numeroJson(o, 'expansion_delta', FONTE),
    health_delta: numeroJson(o, 'health_delta', FONTE),
    eff_delta: numeroJson(o, 'eff_delta', FONTE),
    breakdown: { churn: lista('churn'), expansion: lista('expansion'), health: lista('health'), eff: lista('eff') },
    computed_at: textoJson(o, 'computed_at', FONTE),
    source_call_count: numeroJson(o, 'source_call_count', FONTE),
  };
}
