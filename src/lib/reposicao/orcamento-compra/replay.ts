// src/lib/reposicao/orcamento-compra/replay.ts
// Estoque contrafactual sem as embalagens cortadas (spec §7). Venda perdida não vira backlog.
export interface EntradaReplay {
  estoqueInicial: number;
  /** demanda real por dia a partir da decisão; null = dia censurado (falta real) */
  demanda: (number | null)[];
  recebimentos: { dia: number; qtde: number }[];
  removido: { dia: number; qtde: number } | null;
  /** quando presente, o replay recompra a qtde removida ao cruzar o ponto de pedido */
  politica: { pontoPedido: number; leadTimeDias: number } | null;
}
export interface SaidaReplay {
  rompeu: boolean;
  primeiroDiaRuptura: number | null;
  unidadesPerdidas: number;
  indeterminado: boolean;
  estoqueMedio: number;
  reposicaoPropria: boolean;
}
export type ClasseCorte = 'teria_rompido' | 'adiado' | 'eliminado' | 'indeterminado';

export function replaySku(e: EntradaReplay): SaidaReplay {
  let estoque = e.estoqueInicial;
  let perdidas = 0;
  let primeiro: number | null = null;
  let indeterminado = false;
  let somaEstoque = 0;
  let chegadaPropria: number | null = null;
  let reposicaoPropria = false;
  for (let t = 0; t < e.demanda.length; t++) {
    for (const r of e.recebimentos) if (r.dia === t) estoque += r.qtde;
    if (e.removido && e.removido.dia === t) estoque -= e.removido.qtde;
    if (chegadaPropria === t && e.removido) { estoque += e.removido.qtde; chegadaPropria = null; }
    const d = e.demanda[t];
    if (d === null) indeterminado = true;
    else if (estoque >= d) estoque -= d;
    else {
      perdidas += d - Math.max(estoque, 0);
      estoque = 0;
      if (primeiro === null) primeiro = t;
    }
    if (e.politica && e.removido && !reposicaoPropria && t >= e.removido.dia && estoque <= e.politica.pontoPedido) {
      chegadaPropria = t + e.politica.leadTimeDias;
      reposicaoPropria = true;
    }
    somaEstoque += estoque;
  }
  return {
    rompeu: perdidas > 0,
    primeiroDiaRuptura: primeiro,
    unidadesPerdidas: perdidas,
    indeterminado,
    estoqueMedio: e.demanda.length ? somaEstoque / e.demanda.length : 0,
    reposicaoPropria,
  };
}

export function classificarCorte(com: SaidaReplay, sem: SaidaReplay): ClasseCorte {
  if (com.indeterminado || sem.indeterminado) return 'indeterminado';
  if (sem.unidadesPerdidas > com.unidadesPerdidas) return 'teria_rompido';
  return sem.reposicaoPropria ? 'adiado' : 'eliminado';
}
