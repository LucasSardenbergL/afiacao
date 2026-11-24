/**
 * Prioridade por EXPOSIÇÃO AO ATRASO (onda A da tela de Clientes, calculate-scores v1.9).
 *
 * Por que existe: a prioridade antiga era a média renormalizada de churn (100 − health), recompra e meta.
 * Com o potencial de margem nulo na base inteira, o churn dominava — e quem estava mais morto pontuava
 * mais. Medido em prod (2026-11-24, carteira da vendedora, 707 priorizados): top 100 = 100% `stale`
 * (média 1.196 dias sem compra), 1º `ativo` no rank 206, só 52 valores distintos. O "Meu dia" cortava
 * em 200 por essa nota e não mostrava NENHUM ativo.
 *
 * A regra nova responde "quem a vendedora deve ligar primeiro" com três faixas DISJUNTAS (0–100):
 *   - `atrasado`     (60–100): ativo que passou da própria cadência E tem gasto medido > 0. Ordena pela
 *                     exposição E = (gasto mensal 180d ÷ 30) × (dias sem compra − intervalo) — uma
 *                     ESTIMATIVA de exposição ao atraso, não "receita perdida" (achado /codex).
 *   - `em_dia`       (35–60): ativo com cadência medida que ainda não venceu (ou venceu sem gasto medido).
 *                     Ordena por gasto × proximidade do vencimento (dias ÷ intervalo, teto 1).
 *   - `sem_cadencia` (30–35): ativo com < 3 dias de pedido — cadência DESCONHECIDA. Fila própria, ordenada
 *                     só pelo gasto: não se afirma vencimento que ninguém mediu (achado /codex).
 *   - `reativacao`   (0–30): `stale`. Decai com a recência (lapso recente = mais recuperável).
 * Dentro da faixa a curva é logística (x ÷ (x + referência)): a ORDEM não depende do maior cliente do dia,
 * o que estabiliza o top N. `sem_historico` e insumo obrigatório ausente → `null` (ausente ≠ zero).
 *
 * O canônico mora aqui; a edge carrega o bloco abaixo VERBATIM em
 * `supabase/functions/_shared/prioridade-valor.ts` (Deno não importa de `src/`), pinado pela paridade
 * em `src/lib/scoring/__tests__/prioridadeValor.test.ts`.
 */

// MIRROR-START prioridade-valor — espelhado verbatim em supabase/functions/_shared/prioridade-valor.ts
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

/** Limiar ativo × stale padrão da edge (`sales_active_threshold_days`; sem linha configurada em prod). */
export const DIAS_ATIVO_PADRAO = 180;

/**
 * Os 2–3 fatores que decidiram a nota, em linguagem de vendedor — para o tooltip da coluna Prioridade.
 *
 * Só explica quando a nota GRAVADA bate com a regra recalculada a partir das mesmas colunas persistidas
 * (tolerância de arredondamento). Se não bate — nota ainda da fórmula antiga (edge não recalculada) ou
 * referência/limiar configurados diferentes do padrão — devolve null: explicar uma nota com a regra
 * errada seria fabricar o porquê. Ausente → null, nunca um fator inventado.
 */
export function explicarPrioridade(
  score: {
    sales_history_status: string | null;
    days_since_last_purchase: number | null;
    /** opcional: a base completa (RPC) pode não trazer; ausente → cadência desconhecida. */
    avg_repurchase_interval?: number | null;
    avg_monthly_spend_180d: number | null;
    priority_score: number | null;
  },
  fmtReais: (v: number) => string,
): string[] | null {
  const gravada = score.priority_score;
  if (gravada == null || !Number.isFinite(gravada)) return null;
  const p = calcularPrioridade(
    {
      status: score.sales_history_status,
      dias: score.days_since_last_purchase,
      intervalo: score.avg_repurchase_interval ?? null,
      gastoMensal: score.avg_monthly_spend_180d,
    },
    REFERENCIA_EXPOSICAO_PADRAO,
    DIAS_ATIVO_PADRAO,
  );
  if (!p || Math.abs(p.nota - gravada) > 0.011) return null;
  const dias = score.days_since_last_purchase;
  const intervalo = score.avg_repurchase_interval ?? null;
  const gasto = score.avg_monthly_spend_180d;
  const gastoTxt = gasto != null ? `Compra ${fmtReais(gasto)}/mês (últimos 180 dias)` : null;
  const dia = (n: number) => `${Math.round(n)} ${Math.round(n) === 1 ? 'dia' : 'dias'}`;
  switch (p.faixa) {
    case 'atrasado':
      return [
        `Atrasado: ${dia(p.diasAlemDaCadencia!)} além da recompra habitual (a cada ${dia(intervalo!)})`,
        gastoTxt!,
        `≈ ${fmtReais(p.exposicao!)} de compra em atraso (estimativa)`,
      ];
    case 'em_dia':
      return [`Em dia: comprou há ${dia(dias!)}, costuma recomprar a cada ${dia(intervalo!)}`, gastoTxt!];
    case 'sem_cadencia':
      return ['Recompra habitual ainda desconhecida (menos de 3 dias de pedido)', gastoTxt!];
    case 'reativacao':
      return [`Inativo: sem compra há ${dia(dias!)}`, 'Fila de reativação: abaixo de todo cliente ativo'];
  }
}
