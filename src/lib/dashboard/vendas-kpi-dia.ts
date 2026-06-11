// KPIs "Faturado hoje/ontem" e "Pedidos hoje" do cockpit de vendas (useVendasZone).
// Alinhado ao dashboard Master (useTeamKpis/somarReceita): a verdade do dia é
// `sales_orders.order_date_kpi` (coluna `date` pura, 'YYYY-MM-DD', preenchida de
// `dInc` no sync Omie) comparada por STRING contra `hojeSP()` — sem Date local,
// logo imune a fuso por construção (sem o truque de dia-civil sobre created_at).
// "Faturado" conta só pedido VÁLIDO (status ∉ {cancelado, rascunho}); os
// soft-deletados já saem na query (`.is('deleted_at', null)`).
import { addDias } from './sp-date';
import { isPedidoValido } from './team-kpis';

export interface PedidoVendasKpi {
  total: number | string | null;
  status: string | null;
  order_date_kpi: string | null;
}

export interface VendasKpiDia {
  faturadoHoje: number;
  pedidosHoje: number;
  faturadoOntem: number;
}

/**
 * Classifica cada pedido pelo seu `order_date_kpi` (dia civil canônico) em hoje ×
 * ontem × fora e agrega só os válidos. `hojeISO` é 'YYYY-MM-DD' (de `hojeSP()`).
 */
export function agregarVendasDiaKpi(rows: PedidoVendasKpi[], hojeISO: string): VendasKpiDia {
  const ontem = addDias(hojeISO, -1);
  let faturadoHoje = 0;
  let pedidosHoje = 0;
  let faturadoOntem = 0;
  for (const r of rows) {
    if (!isPedidoValido(r.status)) continue;
    if (r.order_date_kpi == null) continue;
    const dia = r.order_date_kpi.slice(0, 10);
    if (dia === hojeISO) {
      pedidosHoje += 1;
      faturadoHoje += Number(r.total ?? 0);
    } else if (dia === ontem) {
      faturadoOntem += Number(r.total ?? 0);
    }
  }
  return { faturadoHoje, pedidosHoje, faturadoOntem };
}
