/**
 * Seleção dos "melhores clientes" a partir dos COMPRADORES (fatos de quem já
 * compra, vindos da view SQL `v_caca_compradores`).
 *
 * Pipeline:
 *   1. base = TODOS os compradores (perfil de referência para o lift downstream).
 *   2. índice ponderado por PERCENTIS (volume × fidelidade × lucro).
 *   3. melhores = top fração por índice, tiebreak determinístico por documento.
 *
 * Princípio de degradação honesta: dado AUSENTE ≠ ZERO.
 *   - Lucro só entra no percentil entre quem tem `lucro_proxy != null` E
 *     cobertura suficiente. Para os demais, o índice é RENORMALIZADO sobre os
 *     pesos de volume+fidelidade — um comprador forte sem lucro confiável NÃO
 *     afunda como se o lucro fosse zero.
 *
 * Helper PURO — sem IO, sem imports externos além dos tipos.
 */

import type { CompradorRow, MelhorCliente } from './types';

export interface SelecaoMelhores {
  melhores: MelhorCliente[];
  base: Array<{ cidadeUf: string | null; ramo: string | null; familias: string[] }>;
}

interface SelecaoOpts {
  /** Fração superior dos compradores tratada como "melhores" (default 0.2). */
  fracaoTop?: number;
  /** Peso do percentil de lucro no índice (default 0.4). */
  pesoLucro?: number;
  /** Peso do percentil de volume no índice (default 0.3). */
  pesoVolume?: number;
  /** Peso do percentil de fidelidade no índice (default 0.3). */
  pesoFidelidade?: number;
  /** Cobertura mínima do lucro_proxy para ele ser considerado confiável (default 0.5). */
  coberturaMinLucro?: number;
}

/**
 * Percentil de `v` dentro de `valores` (rank fracionário determinístico).
 *
 * Definição: fração de valores ESTRITAMENTE menores que `v`, dividida por (n-1).
 *   - n > 1: (qtd. estritamente menores) / (n - 1) → mínimo do conjunto = 0,
 *     máximo = 1, empates compartilham o mesmo percentil.
 *   - n <= 1: retorna 1 (um único ponto é, por convenção, o "topo").
 *
 * Puro e determinístico (não depende de ordenação prévia nem de NaN).
 */
export function percentil(valores: number[], v: number): number {
  const n = valores.length;
  if (n <= 1) return 1;
  let menores = 0;
  for (const x of valores) {
    if (x < v) menores += 1;
  }
  return menores / (n - 1);
}

/**
 * Seleciona os melhores compradores e devolve a base de referência.
 *
 * Assume que `compradores` já são de UMA empresa (o caller filtra) — o campo
 * `empresa` não é inspecionado aqui.
 */
export function selecionarMelhores(
  compradores: CompradorRow[],
  opts: SelecaoOpts = {},
): SelecaoMelhores {
  const fracaoTop = opts.fracaoTop ?? 0.2;
  const pesoLucro = opts.pesoLucro ?? 0.4;
  const pesoVolume = opts.pesoVolume ?? 0.3;
  const pesoFidelidade = opts.pesoFidelidade ?? 0.3;
  const coberturaMinLucro = opts.coberturaMinLucro ?? 0.5;

  // 1. Base = todos os compradores, mapeados 1:1.
  const base = compradores.map((c) => ({
    cidadeUf: c.cidade_uf,
    ramo: c.ramo,
    familias: c.familias,
  }));

  const n = compradores.length;
  if (n === 0) {
    return { melhores: [], base };
  }

  // 2. Vetores para percentis.
  const volumes = compradores.map((c) => c.volume);
  const nPedidos = compradores.map((c) => c.n_pedidos);
  // Recência: mais recente (menor recencia_dias) = melhor → negamos para que
  // o percentil cresça com a recência.
  const recenciaNeg = compradores.map((c) => -c.recencia_dias);

  // Lucro confiável: só compradores com proxy presente E cobertura suficiente.
  const lucroConfiavel = (c: CompradorRow): boolean =>
    c.lucro_proxy !== null && c.lucro_cobertura >= coberturaMinLucro;
  const lucrosValidos = compradores
    .filter(lucroConfiavel)
    .map((c) => c.lucro_proxy as number);

  // Soma dos pesos quando o lucro está ausente (para renormalizar).
  const somaSemLucro = pesoVolume + pesoFidelidade;

  const comIndice = compradores.map((c) => {
    const pctVolume = percentil(volumes, c.volume);
    const pctFidelidade =
      (percentil(nPedidos, c.n_pedidos) + percentil(recenciaNeg, -c.recencia_dias)) / 2;

    // pctLucro só existe para quem tem lucro confiável; senão null (≠ 0).
    const pctLucro = lucroConfiavel(c)
      ? percentil(lucrosValidos, c.lucro_proxy as number)
      : null;

    const indice =
      pctLucro !== null
        ? pesoLucro * pctLucro + pesoVolume * pctVolume + pesoFidelidade * pctFidelidade
        : // Lucro ausente: renormaliza sobre os pesos restantes — ausência ≠ zero.
          (pesoVolume * pctVolume + pesoFidelidade * pctFidelidade) / (somaSemLucro || 1);

    return { c, indice };
  });

  // 3. Ordena por índice desc, tiebreak determinístico por documento (asc).
  comIndice.sort((a, b) => {
    if (b.indice !== a.indice) return b.indice - a.indice;
    return a.c.documento < b.c.documento ? -1 : a.c.documento > b.c.documento ? 1 : 0;
  });

  const k = Math.ceil(n * fracaoTop);
  const melhores: MelhorCliente[] = comIndice.slice(0, k).map(({ c }) => ({
    documento: c.documento,
    cidadeUf: c.cidade_uf,
    ramo: c.ramo,
    ticketFaixa: c.ticket_faixa,
    familias: c.familias,
  }));

  return { melhores, base };
}
