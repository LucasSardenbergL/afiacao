import { PROB_MIN, type SinaisLigacao, type ModifierBruto } from './schema';

/** Deltas brutos por classe de sinal (ponderados depois por confiança + decay no scoring). */
const DELTA_PRECO_CONCORRENTE = 20; // concorrente mais barato = risco de churn
const DELTA_MARCA_CONCORRENTE = 15; // espelha competitor_mentioned do scoring legado
const DELTA_DEMANDA_NOVA = 10; // sinal de expansão

/**
 * Converte os 4 sinais extraídos de uma ligação em modifiers de scoring, aplicando o
 * contrato money-path: precisão > recall, ausente ≠ zero, nunca fabrica.
 *
 * Oráculo puro — a edge scoring-recalc-client (Deno) replica esta lógica inline.
 */
export function sinaisParaModifiers(s: SinaisLigacao): ModifierBruto[] {
  if (!s.houve_sinal) return [];
  const out: ModifierBruto[] = [];

  // PREÇO — contrato estrito (Codex): só pontua concorrente mais barato, dito pelo CLIENTE,
  // com unidade comparável e confiança suficiente. Sem isso → inteligência crua, não pontua.
  for (const p of s.precos) {
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
      reason: `Concorrente ${p.concorrente ?? '?'} cobra ${p.valor} ${p.moeda}/${p.unidade_base} em ${p.produto}`,
      classe: 'preco',
    });
  }

  // MARCA — concorrente em uso, dito pelo cliente.
  for (const m of s.marcas_em_uso) {
    if (!(m.e_concorrente && m.speaker_is_customer && m.confianca >= PROB_MIN)) continue;
    out.push({
      dimension: 'churn',
      kind: 'marca_concorrente_em_uso',
      delta: DELTA_MARCA_CONCORRENTE,
      weight: m.confianca,
      reason: `Cliente usa ${m.marca}`,
      classe: 'marca',
    });
  }

  // DEMANDA NOVA — expansão.
  for (const d of s.demandas_novas) {
    if (d.confianca < PROB_MIN) continue;
    out.push({
      dimension: 'expansion',
      kind: 'demanda_nova',
      delta: DELTA_DEMANDA_NOVA,
      weight: d.confianca,
      reason: `Demanda: ${d.descricao}`,
      classe: 'demanda',
    });
  }

  // PRODUTO-GAP — não pontua (consumo = Fatia 3). Persistido no envelope, fora daqui.
  return out;
}
