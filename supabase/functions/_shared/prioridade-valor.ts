/**
 * Prioridade por exposição ao atraso de `calculate-scores` (v1.9, onda A da tela de Clientes).
 *
 * Módulo próprio, e não inline no `index.ts`, pelo mesmo motivo de `frequencia-recompra.ts`: o index
 * importa `npm:@supabase/supabase-js` e `test:edges` roda com `--no-remote`, então a regra inline seria
 * inalcançável por teste de comportamento. Ver `prioridade-valor_test.ts`.
 *
 * O canônico é `src/lib/scoring/prioridadeValor.ts` (lá está o porquê inteiro); Deno não importa de
 * `src/`, daí o espelho VERBATIM abaixo, pinado por `src/lib/scoring/__tests__/prioridadeValor.test.ts`.
 */

// MIRROR-START prioridade-valor — espelhado verbatim de src/lib/scoring/prioridadeValor.ts
export type FaixaPrioridade = 'atrasado' | 'em_dia' | 'sem_cadencia' | 'reativacao';

export interface InsumosPrioridade {
  /** sales_history_status: só `ativo` e `stale` têm prioridade de recompra. */
  status: string | null;
  /** days_since_last_purchase (null = não medido). */
  dias: number | null;
  /** avg_repurchase_interval (null ou ≤ 0 = cadência não medida). */
  intervalo: number | null;
  /** avg_monthly_spend_180d (null = não medido; 0 é medido). */
  gastoMensal: number | null;
}

export interface PrioridadeCalculada {
  nota: number;
  faixa: FaixaPrioridade;
  /** R$ estimados de exposição ao atraso — só na faixa `atrasado`; null nas demais. */
  exposicao: number | null;
  /** dias além da cadência — só na faixa `atrasado`; null nas demais. */
  diasAlemDaCadencia: number | null;
}

/** Referência (R$) da curva logística: exposição igual a ela fica no meio da faixa. */
export const REFERENCIA_EXPOSICAO_PADRAO = 1000;

function finito(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function duasCasas(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Posição logística dentro da faixa [piso, piso + largura): nunca alcança o teto da faixa. */
function naFaixa(piso: number, largura: number, x: number, referencia: number): number {
  const fracao = x > 0 ? x / (x + referencia) : 0;
  return duasCasas(piso + (largura - 0.01) * fracao);
}

/** Referência configurável com guarda: não finita ou ≤ 0 → padrão (sem ela a curva vira degrau). */
export function referenciaExposicao(raw: unknown): number {
  const v = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(v) && v > 0 ? v : REFERENCIA_EXPOSICAO_PADRAO;
}

export function calcularPrioridade(
  ins: InsumosPrioridade,
  referencia: number,
  diasAtivo: number,
): PrioridadeCalculada | null {
  const dias = finito(ins.dias) ? Math.max(0, ins.dias) : null;
  if (ins.status === 'stale') {
    if (dias == null) return null;
    // `stale` é dias > limiar por construção; o piso limiar+1 só protege de status e dias incoerentes.
    const nota = duasCasas(29.99 * (diasAtivo / Math.max(dias, diasAtivo + 1)));
    return { nota, faixa: 'reativacao', exposicao: null, diasAlemDaCadencia: null };
  }
  if (ins.status !== 'ativo') return null;
  const gasto = finito(ins.gastoMensal) ? ins.gastoMensal : null;
  if (dias == null || gasto == null) return null;
  const intervalo = finito(ins.intervalo) && ins.intervalo > 0 ? ins.intervalo : null;
  if (intervalo == null) {
    return { nota: naFaixa(30, 5, gasto, referencia), faixa: 'sem_cadencia', exposicao: null, diasAlemDaCadencia: null };
  }
  if (dias > intervalo && gasto > 0) {
    const diasAlem = dias - intervalo;
    const exposicao = (gasto / 30) * diasAlem;
    return { nota: naFaixa(60, 40, exposicao, referencia), faixa: 'atrasado', exposicao, diasAlemDaCadencia: diasAlem };
  }
  const proximidade = Math.min(dias / intervalo, 1);
  return { nota: naFaixa(35, 25, gasto * proximidade, referencia), faixa: 'em_dia', exposicao: null, diasAlemDaCadencia: null };
}
// MIRROR-END
