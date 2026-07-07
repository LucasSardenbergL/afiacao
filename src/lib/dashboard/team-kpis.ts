/**
 * KPIs agregados de time pro dashboard Master (CEO). Puros e testáveis.
 * Definições validadas com codex (ver spec):
 *  - pedido válido = status ∉ {cancelado, rascunho};
 *  - receita = Σ total de válidos com order_date_kpi na janela (escopo de account/data feito na query);
 *  - vendedores ativos = distinct de quem teve atividade desde um instante UTC.
 * Spec: docs/superpowers/specs/2026-06-04-master-visao-time-design.md
 */

/** Status que NÃO contam como receita realizada (rascunho = draft; cancelado = anulado). */
const ORDER_STATUS_INVALIDOS: string[] = ['cancelado', 'rascunho'];

export function isPedidoValido(status: string | null | undefined): boolean {
  return status != null && !ORDER_STATUS_INVALIDOS.includes(status);
}

export interface OrderRow {
  total: number | null;
  status: string | null;
  order_date_kpi: string | null;
}

/** Σ `total` dos pedidos válidos com `order_date_kpi` em [deISO, ateISO). Comparação de string ('YYYY-MM-DD'). */
export function somarReceita(orders: OrderRow[], deISO: string, ateISO: string): number {
  return orders
    .filter(
      (o) =>
        isPedidoValido(o.status) &&
        o.order_date_kpi != null &&
        o.order_date_kpi >= deISO &&
        o.order_date_kpi < ateISO,
    )
    .reduce((s, o) => s + (o.total ?? 0), 0);
}

export interface AtividadeRow {
  id: string | null;
  ts: string | null;
}

/** Contagem distinct de `id` cujo `ts` (ISO) é ≥ `desdeUTC`. Ignora id/ts nulos. */
export function contarAtivos(linhas: AtividadeRow[], desdeUTC: string): number {
  const set = new Set<string>();
  for (const l of linhas) {
    if (l.id && l.ts && l.ts >= desdeUTC) set.add(l.id);
  }
  return set.size;
}

// ---------------------------------------------------------------------------
// Ranking de vendedores (Master v2)
// ---------------------------------------------------------------------------

export interface OrderRankRow {
  total: number | null;
  status: string | null;
  created_by: string | null;
}
export interface RankingVendedor {
  id: string;
  nome: string;
  receita: number;
  pedidos: number;
}
export interface RankingResult {
  ranking: RankingVendedor[];
  /** Pedidos válidos sem vendedor atribuído (created_by NULL ou não-vendedor). Conta no total, fora do ranking. */
  naoAtribuido: { receita: number; pedidos: number };
  /** Vendedores cadastrados sem nenhum pedido válido na janela. */
  semAtividade: number;
}

/**
 * Ranking de vendedores por receita de pedidos válidos, ATRIBUÍDO por `created_by`
 * (quem lançou o pedido). `vendedores` = Map<userId, nome> dos vendedores reais
 * (commercial_role farmer/hunter/closer). created_by fora desse set → bucket "não atribuído".
 * Ordena por receita desc. Não lista vendedor sem pedido (entra em `semAtividade`).
 */
export function montarRanking(orders: OrderRankRow[], vendedores: Map<string, string>): RankingResult {
  const acc = new Map<string, { receita: number; pedidos: number }>();
  let naoR = 0;
  let naoP = 0;
  for (const o of orders) {
    if (!isPedidoValido(o.status)) continue;
    const v = o.total ?? 0;
    if (o.created_by && vendedores.has(o.created_by)) {
      const cur = acc.get(o.created_by) ?? { receita: 0, pedidos: 0 };
      cur.receita += v;
      cur.pedidos += 1;
      acc.set(o.created_by, cur);
    } else {
      naoR += v;
      naoP += 1;
    }
  }
  const ranking = [...acc.entries()]
    .map(([id, a]) => ({ id, nome: vendedores.get(id) ?? 'Vendedor', receita: a.receita, pedidos: a.pedidos }))
    .sort((a, b) => b.receita - a.receita);
  return {
    ranking,
    naoAtribuido: { receita: naoR, pedidos: naoP },
    semAtividade: vendedores.size - ranking.length,
  };
}

/**
 * Variação percentual (fração) de `atual` vs `anterior`. `null` quando não há base
 * (`anterior <= 0`) — crescimento % a partir de zero é indefinido (não fabrica "∞%"/"+100%").
 */
export function variacaoPct(atual: number, anterior: number): number | null {
  if (anterior <= 0) return null;
  return (atual - anterior) / anterior;
}
