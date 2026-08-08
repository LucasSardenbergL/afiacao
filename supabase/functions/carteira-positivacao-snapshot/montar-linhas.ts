// Montagem PURA das linhas do snapshot mensal de positivação.
//
// Mora fora do index.ts porque `test:edges` roda com `--no-remote`: o index importa
// `npm:@supabase/supabase-js` e por isso é intestável: só a lógica pura pode ser coberta
// (CLAUDE.md, "Edge tem suíte PRÓPRIA (Deno)"). Ver montar-linhas_test.ts.
//
// O que esta função carrega de invariante (docs/agent/money-path.md):
//   • `had_order_in_month` e `contacted_in_month` são DUAS pontas independentes. O snapshot
//     existe para cruzar as duas — sem o par, "a rota converte?" não tem resposta.
//   • Esforço de quem não está na carteira NÃO cria linha: o snapshot é uma fotografia da
//     carteira do mês, e uma linha órfã viraria denominador fantasma na taxa de positivação.
//   • `total: null` degrada para 0 na SOMA (não vira NaN, que contaminaria o mês inteiro).
import type { LinhaAssignment, LinhaPedidoMes } from "../_shared/mapas-paginados.ts";

export interface LinhaSnapshot {
  mes: string;
  customer_user_id: string;
  owner_user_id: string;
  eligible: boolean;
  had_order_in_month: boolean;
  first_order_date_in_month: string | null;
  revenue_month: number;
  contacted_in_month: boolean;
  visited_in_month: boolean;
}

export function montarLinhasSnapshot(
  mesIso: string,
  assignments: LinhaAssignment[],
  pedidosDoMes: LinhaPedidoMes[],
  contatados: Set<string>,
  visitados: Set<string>,
): LinhaSnapshot[] {
  // Pedidos válidos do mês por cliente (receita + 1ª data). order_date_kpi é não-nulo (backfill).
  const byCustomer = new Map<string, { receita: number; primeira: string | null }>();
  for (const o of pedidosDoMes) {
    const cur = byCustomer.get(o.customer_user_id) ?? { receita: 0, primeira: null };
    cur.receita += Number(o.total ?? 0);
    if (!cur.primeira || o.order_date_kpi < cur.primeira) cur.primeira = o.order_date_kpi;
    byCustomer.set(o.customer_user_id, cur);
  }

  return assignments.map((a) => {
    const ped = byCustomer.get(a.customer_user_id);
    return {
      mes: mesIso,
      customer_user_id: a.customer_user_id,
      owner_user_id: a.owner_user_id,
      eligible: a.eligible,
      had_order_in_month: !!ped,
      first_order_date_in_month: ped?.primeira ?? null,
      revenue_month: ped?.receita ?? 0,
      contacted_in_month: contatados.has(a.customer_user_id),
      visited_in_month: visitados.has(a.customer_user_id),
    };
  });
}
