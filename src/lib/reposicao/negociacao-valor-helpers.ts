// src/lib/reposicao/negociacao-valor-helpers.ts
// Modelo de valor da Negociação Paralela (desconto flat condicional Sayerlack).
// Base de custo SEPARADA: economia sobre o preço de compra (p); capital parado sobre o CMC (c).
// Módulo puro (TDD). Espelha o spec docs/superpowers/specs/2026-06-06-negociacao-paralela-net-rs-design.md.
//
//   economia(Q)       = δ·p·Q
//   custo_carregar(Q) = c·k·Q²/(2A)        (estoque médio Q/2 pelo tempo Q/d; base-estoque ~0, conservador)
//   net(Q)            = economia − custo_carregar
//   lote ótimo  Q*    = δ·p·A/(c·k)
//   teto        Qmax  = 2·Q*               (net = 0)
//   net no ótimo      = (δ·p)²·A/(2·c·k)
//   prêmio anual      = δ·p·A              (ordena a fila)

export const DESCONTO_PADRAO = 0.08;

export interface InsumoNegociacao {
  sku_codigo_omie: string;
  sku_descricao: string | null;
  consumo_anual: number;        // A (un/ano) = demanda_media_diaria × 365
  preco_compra: number | null;  // p (R$/un) = preco_compra_real
  cmc: number | null;           // c (R$/un) = CMC do Omie (só quando fonte_preco='cmc')
  custo_capital_anual: number;  // k (fração/ano) = custo_capital_efetivo_perc / 100
}

type MotivoInelegivel = 'sem_giro' | 'sem_preco_compra' | 'sem_cmc' | 'sem_custo_capital';

export interface ValorNegociacao {
  elegivel: boolean;
  motivo_inelegivel: MotivoInelegivel | null;
  desconto_aplicado: number;
  premio_anual: number | null;
  net_negociacao: number | null;
  lote_otimo: number | null;
  teto_volume: number | null;
  meses_otimo: number | null;
  meses_teto: number | null;
}

function positivo(x: number | null | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

export function clampDesconto(d: number): number {
  if (!Number.isFinite(d) || d <= 0) return DESCONTO_PADRAO;
  return Math.min(d, 0.5);
}

export function premioAnual(delta: number, p: number | null, A: number): number | null {
  if (!positivo(p) || !positivo(A)) return null;
  return delta * p * A;
}

export function loteOtimo(delta: number, p: number | null, c: number | null, A: number, k: number): number | null {
  if (!positivo(p) || !positivo(c) || !positivo(A) || !positivo(k)) return null;
  return (delta * p * A) / (c * k);
}

export function netNoLote(delta: number, p: number, c: number, A: number, k: number, Q: number): number {
  return delta * p * Q - (c * k * Q * Q) / (2 * A);
}

export function netNoOtimo(delta: number, p: number | null, c: number | null, A: number, k: number): number | null {
  if (!positivo(p) || !positivo(c) || !positivo(A) || !positivo(k)) return null;
  return ((delta * p) ** 2 * A) / (2 * c * k);
}

export function avaliarNegociacao(ins: InsumoNegociacao, descontoPedido: number): ValorNegociacao {
  const delta = clampDesconto(descontoPedido);
  const A = ins.consumo_anual;
  const vazio = {
    desconto_aplicado: delta, premio_anual: null, net_negociacao: null,
    lote_otimo: null, teto_volume: null, meses_otimo: null, meses_teto: null,
  };
  if (!positivo(A)) return { elegivel: false, motivo_inelegivel: 'sem_giro', ...vazio };
  if (!positivo(ins.preco_compra)) return { elegivel: false, motivo_inelegivel: 'sem_preco_compra', ...vazio };

  const premio = premioAnual(delta, ins.preco_compra, A);
  if (!positivo(ins.cmc)) {
    return { elegivel: false, motivo_inelegivel: 'sem_cmc', ...vazio, premio_anual: premio };
  }
  if (!positivo(ins.custo_capital_anual)) {
    return { elegivel: false, motivo_inelegivel: 'sem_custo_capital', ...vazio, premio_anual: premio };
  }
  const Qstar = loteOtimo(delta, ins.preco_compra, ins.cmc, A, ins.custo_capital_anual)!;
  const Qmax = 2 * Qstar;
  const giroMes = A / 12;
  return {
    elegivel: true,
    motivo_inelegivel: null,
    desconto_aplicado: delta,
    premio_anual: premio,
    net_negociacao: netNoOtimo(delta, ins.preco_compra, ins.cmc, A, ins.custo_capital_anual),
    lote_otimo: Qstar,
    teto_volume: Qmax,
    meses_otimo: Qstar / giroMes,
    meses_teto: Qmax / giroMes,
  };
}
