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
