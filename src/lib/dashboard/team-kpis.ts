/**
 * KPIs agregados de time pro dashboard Master (CEO). Puros e testáveis.
 * Definições validadas com codex (ver spec):
 *  - pedido válido = status ∉ {cancelado, rascunho};
 *  - receita = Σ total de válidos com order_date_kpi na janela (escopo de account/data feito na query);
 *  - vendedores ativos = distinct de quem teve atividade desde um instante UTC.
 * Spec: docs/superpowers/specs/2026-06-04-master-visao-time-design.md
 */

/** Status que NÃO contam como receita realizada (rascunho = draft; cancelado = anulado). */
export const ORDER_STATUS_INVALIDOS: string[] = ['cancelado', 'rascunho'];

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
