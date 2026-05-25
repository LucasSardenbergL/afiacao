// src/lib/reposicao/compras-otimizador-helpers.ts
// Otimizador de Compras — decisão "comprar mais?" net-R$ MARGINAL por SKU. Módulo puro (TDD).
// Toda a matemática vive aqui; a view v_otimizador_compras_insumos só junta os fatos.
// Metodologia: docs/superpowers/specs/2026-05-25-otimizador-compras-design.md (Codex 2 passes).

export type EscopoPromo = 'sku' | 'grupo' | 'fornecedor_total';
export type RecomendacaoCompra = 'comprar_mais' | 'manter_base' | 'simulacao_parcial' | 'falta_dado';
export interface FaixaDesconto { volume_minimo: number; desconto_promo_perc: number; prazo_perc?: number }

export function qtdMinimaEfetiva(lote: number | null, forcado: number | null): number {
  return Math.max(lote ?? 0, forcado ?? 0);
}

export function qtdBase(input: { qtde_base: number | null; lote_minimo_fornecedor: number | null; minimo_forcado_manual: number | null }): number {
  return Math.max(input.qtde_base ?? 0, qtdMinimaEfetiva(input.lote_minimo_fornecedor, input.minimo_forcado_manual));
}

// Melhor desconto cujo volume_minimo ≤ q (curva progressiva → pega o maior aplicável).
export function descontoAplicavel(curva: FaixaDesconto[], q: number): number {
  let best = 0;
  for (const f of curva) { if (q >= f.volume_minimo && f.desconto_promo_perc > best) best = f.desconto_promo_perc; }
  return best;
}

function arredondaLote(q: number, lote: number | null): number {
  if (!lote || lote <= 0) return Math.ceil(q);
  return Math.ceil(q / lote) * lote;
}

// Candidatos: q_base + cada volume_minimo (≥ q_base) + limite do aumento + limite da ruptura, no lote.
export function gerarCandidatos(input: {
  q_base: number; lote: number | null; demanda_diaria: number | null;
  curva: FaixaDesconto[]; dias_ate_aumento: number | null; ruptura_dias: number | null;
}): number[] {
  const set = new Set<number>([input.q_base]);
  for (const f of input.curva) { const q = arredondaLote(f.volume_minimo, input.lote); if (q >= input.q_base) set.add(q); }
  const d = input.demanda_diaria ?? 0;
  if (d > 0 && input.dias_ate_aumento != null && input.dias_ate_aumento > 0) {
    const q = arredondaLote(d * input.dias_ate_aumento, input.lote); if (q >= input.q_base) set.add(q);
  }
  if (d > 0 && input.ruptura_dias != null && input.ruptura_dias > 0) {
    const q = arredondaLote(d * input.ruptura_dias, input.lote); if (q >= input.q_base) set.add(q);
  }
  return [...set].sort((a, b) => a - b);
}

export function capitalExtra(input: { valor_extra: number; cm_anual: number; demanda_diaria: number | null; q_base: number; q_extra: number }): number {
  const d = input.demanda_diaria ?? 0;
  if (d <= 0) return 0;
  const diasEfetivos = (input.q_base / d) + 0.5 * (input.q_extra / d);
  return input.valor_extra * input.cm_anual * (diasEfetivos / 365);
}

export function aumentoEvitadoRs(input: { q_cand: number; q_base: number; demanda_diaria: number | null; dias_ate_aumento: number | null; aumento_perc: number | null; preco_unit: number }): number {
  const d = input.demanda_diaria ?? 0;
  if (!input.aumento_perc || input.dias_ate_aumento == null || input.dias_ate_aumento < 0) return 0;
  const consumoAteVigencia = d * input.dias_ate_aumento;
  const qElegivel = Math.max(0, input.q_cand - Math.max(input.q_base, consumoAteVigencia));
  return qElegivel * input.preco_unit * (input.aumento_perc / 100);
}

export function impactoPrazoRs(input: { prazo_cand_perc: number | null; prazo_padrao_perc: number | null; valor_candidato: number }): number {
  const cand = input.prazo_cand_perc ?? input.prazo_padrao_perc ?? 0;
  const padrao = input.prazo_padrao_perc ?? 0;
  return (cand - padrao) / 100 * input.valor_candidato; // + = encargo (custo); − = desconto (benefício)
}

export function freteIncrementalRs(input: { valor_extra: number; frete_perc_valor: number | null; frete_fixo: number | null; frete_taxa_pedido: number | null }): number {
  const perc = (input.frete_perc_valor ?? 0) / 100 * input.valor_extra;
  return perc + (input.frete_fixo ?? 0) + (input.frete_taxa_pedido ?? 0);
}

export function descontoIncrementalRs(input: { curva: FaixaDesconto[]; q_cand: number; q_base: number; preco_unit: number }): number {
  const dCand = descontoAplicavel(input.curva, input.q_cand) / 100;
  const dBase = descontoAplicavel(input.curva, input.q_base) / 100;
  return input.q_cand * input.preco_unit * dCand - input.q_base * input.preco_unit * dBase;
}
