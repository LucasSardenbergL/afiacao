// src/lib/reposicao/orcamento-compra/valor.ts
// ΔV por embalagem incremental (spec §5.2): comprar k AGORA vs adiar para a próxima oportunidade.
import type { AmostraDemanda } from './demanda';

export interface ParamsValor {
  /** preco_venda_medio − custo de aquisição; null se algum ausente */
  margemUnit: number | null;
  /** custo de aquisição atual (preço da linha, não CMC) */
  custoUnit: number | null;
  /** cm_anual / 365 */
  hDia: number;
  diasAteChegada: number;
  demandaMediaDiaria: number;
  /** janela de carregamento = diasTotal − diasAteChegada; spec §5.2 */
  diasJanela: number;
  /** (preço cheio − preço promo) por unidade; 0 sem promoção */
  promoBeneficioUnit: number;
  horizontePromoDias: number;
}

export interface ValorEmbalagem {
  deltaV: number | null;
  unidadesAtendidas: number | null;
  motivoSemScore: 'preco_ou_margem_ausente' | 'historico_insuficiente' | null;
}

export function atendidas(estoqueEfetivo: number, Q: number, a: AmostraDemanda): number {
  const backlog = Math.max(-estoqueEfetivo, 0);
  const onhand = Math.max(Math.max(estoqueEfetivo, 0) - a.ateChegada, 0);
  const demandaApos = a.total - a.ateChegada;
  return Math.min(Q, backlog) + Math.min(onhand + Math.max(Q - backlog, 0), demandaApos);
}

export function valorDasEmbalagens(
  estoqueEfetivo: number,
  qtdes: number[],
  amostras: AmostraDemanda[],
  p: ParamsValor,
): ValorEmbalagem[] {
  if (p.margemUnit == null || p.custoUnit == null) {
    return qtdes.map(() => ({ deltaV: null, unidadesAtendidas: null, motivoSemScore: 'preco_ou_margem_ausente' }));
  }
  if (amostras.length === 0) {
    return qtdes.map(() => ({ deltaV: null, unidadesAtendidas: null, motivoSemScore: 'historico_insuficiente' }));
  }
  const backlog = Math.max(-estoqueEfetivo, 0);
  const d = p.demandaMediaDiaria;
  const onhandMedio = Math.max(Math.max(estoqueEfetivo, 0) - d * p.diasAteChegada, 0);
  const out: ValorEmbalagem[] = [];
  let qAnterior = 0;
  for (const q of qtdes) {
    const qAtual = qAnterior + q;
    let soma = 0;
    for (const a of amostras) soma += atendidas(estoqueEfetivo, qAtual, a) - atendidas(estoqueEfetivo, qAnterior, a);
    const unidades = soma / amostras.length;
    // parte da embalagem que vai para a prateleira (não cobre backlog)
    const qEstocada = Math.max(qAtual - backlog, 0) - Math.max(qAnterior - backlog, 0);
    const posicaoAntes = onhandMedio + Math.max(qAnterior - backlog, 0);
    const dias = d > 0 ? Math.min((posicaoAntes + qEstocada / 2) / d, p.diasJanela) : p.diasJanela;
    const carregamento = p.custoUnit * p.hDia * qEstocada * dias;
    const promo = dias <= p.horizontePromoDias ? p.promoBeneficioUnit * qEstocada : 0;
    out.push({ deltaV: p.margemUnit * unidades - carregamento + promo, unidadesAtendidas: unidades, motivoSemScore: null });
    qAnterior = qAtual;
  }
  return out;
}

/** Quantidade mínima que cobre a falta no caminho médio entre a chegada e a próxima oportunidade (spec §5.4). */
export function quantidadeProtegida(estoqueEfetivo: number, demandaMediaDiaria: number, diasAteChegada: number, diasTotal: number): number {
  const backlog = Math.max(-estoqueEfetivo, 0);
  const onhand = Math.max(Math.max(estoqueEfetivo, 0) - demandaMediaDiaria * diasAteChegada, 0);
  const falta = Math.max(demandaMediaDiaria * (diasTotal - diasAteChegada) - onhand, 0);
  return backlog + falta;
}
