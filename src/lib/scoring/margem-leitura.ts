/**
 * Política de negócio sobre a margem lida de `farmer_client_scores.gross_margin_pct`.
 *
 * A mecânica (escala 0–100, ausente → `null`) vive em `@/lib/margem`, na plataforma.
 * Aqui vive o que é decisão de NEGÓCIO: a partir de que ponto uma margem é boa, e como
 * agregar a margem de uma carteira sem mentir sobre a cobertura.
 *
 * Não confundir com `./margin.ts`, que CALCULA margem a partir de itens de pedido.
 */

import { lerMargemPct } from '@/lib/margem';

/**
 * Thresholds do badge de margem, em escala 0–100.
 *
 * Tradução literal dos `0.3` / `0.15` que `CustomerHero` usava quando o código tratava a
 * coluna como fração. A calibração pela distribuição real (p50 = 56,39% ⇒ com 30/15 a
 * maioria pinta verde e o gradiente informa pouco) é follow-up DELIBERADO: decidir os
 * cortes é decisão de produto, e o founder optou por fazê-la vendo a distribuição na tela
 * em vez de embuti-la num PR de conserto técnico.
 */
const MARGEM_BOA = 30;
const MARGEM_ATENCAO = 15;

export type TomMargem = 'success' | 'warning' | 'error' | 'neutral';

/**
 * Tom semântico do badge de margem. Margem desconhecida é `neutral` — não `error`.
 * Pintar de vermelho o que não foi medido acusa o cliente de um problema que é nosso.
 */
export function tomMargem(v: unknown): TomMargem {
  const n = lerMargemPct(v);
  if (n === null) return 'neutral';
  if (n >= MARGEM_BOA) return 'success';
  if (n >= MARGEM_ATENCAO) return 'warning';
  return 'error';
}

export interface MediaMargem {
  /** Média das margens CONHECIDAS. `null` se nenhuma o for — nunca 0. */
  media: number | null;
  /** Quantas entradas tinham margem conhecida. */
  conhecidas: number;
  /** Total de entradas consideradas. */
  total: number;
}

/**
 * Média da margem sobre uma carteira, contando SOMENTE as margens conhecidas.
 *
 * Devolve a contagem junto porque truncar em silêncio é proibido no money-path: "53,5%"
 * sozinho finge cobrir a carteira inteira quando cobre 1.052 de 1.214. Quem exibe o KPI
 * tem de poder dizer sobre quantos ele fala.
 *
 * O bug que isto substitui: `reduce((a, c) => a + Number(c.gross_margin_pct || 0), 0) /
 * clients.length` soma os ausentes como 0 E os conta no denominador — subestimando a
 * média duas vezes.
 */
export function mediaMargem(vs: readonly unknown[]): MediaMargem {
  let soma = 0;
  let conhecidas = 0;
  for (const v of vs) {
    const n = lerMargemPct(v);
    if (n === null) continue;
    soma += n;
    conhecidas += 1;
  }
  return {
    media: conhecidas > 0 ? soma / conhecidas : null,
    conhecidas,
    total: vs.length,
  };
}
