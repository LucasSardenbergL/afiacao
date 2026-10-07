/**
 * KPIs agregados de time pro dashboard Master (CEO). Puros e testáveis.
 * Definições validadas com codex (ver spec):
 *  - pedido válido = status ∉ STATUS_NAO_VENDA (a autoridade do universo de venda; era
 *    {cancelado, rascunho} — uma cópia que deixava orçamento e pendente contarem como receita);
 *  - receita = Σ total de válidos com order_date_kpi na janela (escopo de account/data feito na query);
 *  - vendedores ativos = distinct de quem teve atividade desde um instante UTC.
 * Spec: docs/superpowers/specs/2026-06-04-master-visao-time-design.md
 */

import { STATUS_NAO_VENDA } from '@/lib/farmer/universo-pedidos';

/**
 * Pedido que conta como receita: status fora de `STATUS_NAO_VENDA`. A query já filtra o mesmo
 * universo (fetchPedidosMTD, useVendasZone); este filtro em memória é a defesa do agregador PURO, que
 * também recebe linhas de teste — e lê a MESMA lista, então as duas camadas não podem divergir.
 */
export function isPedidoValido(status: string | null | undefined): boolean {
  return status != null && !STATUS_NAO_VENDA.includes(status);
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
// Ranking de vendedores (Master) — pelo DONO DA CARTEIRA do cliente
// ---------------------------------------------------------------------------

export interface OrderRankRow {
  total: number | null;
  status: string | null;
  /** Cliente do pedido: a venda vai para o dono ATUAL da carteira elegível dele. */
  customer_user_id: string | null;
}
interface RankingVendedor {
  id: string;
  nome: string;
  receita: number;
  pedidos: number;
}
export interface RankingResult {
  ranking: RankingVendedor[];
  /** Pedidos válidos de cliente com carteira ELEGÍVEL cujo dono não é vendedor (hoje: o master e o pool órfão). */
  carteiraNaoVendedor: { receita: number; pedidos: number };
  /** Pedidos válidos sem carteira elegível (cliente sem carteira, carteira inelegível, pedido sem cliente). */
  naoAtribuido: { receita: number; pedidos: number };
  /** Vendedores cadastrados sem nenhum pedido válido na janela. */
  semAtividade: number;
}

/**
 * Ranking de vendedores por receita de pedidos válidos, ATRIBUÍDO ao dono ATUAL da carteira ELEGÍVEL do
 * cliente — a régua da positivação e da cadeia de comissão. O `created_by` não entra: na importada ele é
 * carimbo técnico (o 1º staff do `profiles`), não quem vendeu.
 * `donoPorCliente` = cliente → dono, SÓ `eligible`; `vendedores` = userId → nome (commercial_role
 * farmer/hunter/closer). Os dois vão NOMEADOS: são do mesmo tipo, e trocá-los compilaria.
 * Dono fora de `vendedores` → `carteiraNaoVendedor`; sem dono → `naoAtribuido`. Ordena por receita desc;
 * vendedor sem pedido entra em `semAtividade`.
 * Spec: docs/superpowers/specs/2026-10-06-ranking-atribuicao-por-carteira-design.md
 */
export function montarRanking(
  orders: OrderRankRow[],
  { donoPorCliente, vendedores }: { donoPorCliente: Map<string, string>; vendedores: Map<string, string> },
): RankingResult {
  const acc = new Map<string, { receita: number; pedidos: number }>();
  const carteiraNaoVendedor = { receita: 0, pedidos: 0 };
  const naoAtribuido = { receita: 0, pedidos: 0 };
  for (const o of orders) {
    if (!isPedidoValido(o.status)) continue;
    const v = o.total ?? 0;
    const dono = o.customer_user_id ? donoPorCliente.get(o.customer_user_id) : undefined;
    if (dono !== undefined && vendedores.has(dono)) {
      const cur = acc.get(dono) ?? { receita: 0, pedidos: 0 };
      cur.receita += v;
      cur.pedidos += 1;
      acc.set(dono, cur);
      continue;
    }
    const balde = dono === undefined ? naoAtribuido : carteiraNaoVendedor;
    balde.receita += v;
    balde.pedidos += 1;
  }
  const ranking = [...acc.entries()]
    .map(([id, a]) => ({ id, nome: vendedores.get(id) ?? 'Vendedor', receita: a.receita, pedidos: a.pedidos }))
    .sort((a, b) => b.receita - a.receita);
  return {
    ranking,
    carteiraNaoVendedor,
    naoAtribuido,
    semAtividade: vendedores.size - ranking.length,
  };
}

/**
 * O card se esconde só quando NENHUM dos três destinos tem pedido: um mês só de carteira de não-vendedor
 * (ex.: dia 1 com um pedido do pool órfão) é um mês COM venda e precisa aparecer.
 */
export function rankingSemPedido(r: RankingResult): boolean {
  return r.ranking.length === 0 && r.carteiraNaoVendedor.pedidos === 0 && r.naoAtribuido.pedidos === 0;
}

/**
 * Variação percentual (fração) de `atual` vs `anterior`. `null` quando não há base
 * (`anterior <= 0`) — crescimento % a partir de zero é indefinido (não fabrica "∞%"/"+100%").
 */
export function variacaoPct(atual: number, anterior: number): number | null {
  if (anterior <= 0) return null;
  return (atual - anterior) / anterior;
}
