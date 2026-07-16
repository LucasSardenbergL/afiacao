// Cálculo de economia da afiação (ROI vs. comprar ferramenta nova).
// Extraído de src/pages/SavingsDashboard.tsx para ser a ÚNICA fonte do número —
// ele agora aparece em duas telas (SavingsDashboard + CentralFerramenta) e não
// pode divergir. Função PURA (now injetável) → testável sem render nem relógio.
import { format, subMonths } from 'date-fns';
import { ptBR } from 'date-fns/locale';

/** Custo médio estimado de comprar uma ferramenta NOVA (sem dado real disponível). */
export const AVG_NEW_TOOL_COST = 250; // R$ estimado

/** Pedido mínimo necessário para o cálculo (compatível com DeliveredOrder de useOrders). */
export interface SavingsOrderInput {
  created_at: string;
  total: number;
  items: unknown;
}

export interface SavingsMonthly {
  month: string;
  sharpeningCost: number;
  newToolCost: number;
  savings: number;
  toolCount: number;
}

export interface SavingsSummary {
  /** Série dos últimos 6 meses (para os gráficos). */
  monthlyData: SavingsMonthly[];
  /** Total de ferramentas afiadas no período (soma das quantidades dos itens). */
  totalTools: number;
  /** Total investido em afiação (real, dos pedidos). */
  totalSpent: number;
  /** Economia estimada = totalTools × custo-novo − investido. Pode ser negativa. */
  totalSavings: number;
  /** % economizado vs. comprar novo. 0 quando não há afiações (ausência, não fabricação). */
  savingsPercent: number;
}

/** Quantidade de ferramentas de um pedido = soma das quantidades dos itens (default 1/item). */
function contarFerramentas(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  return (items as Array<{ quantity?: number }>).reduce(
    (sum, item) => sum + (Number(item?.quantity) || 1),
    0,
  );
}

/**
 * Agrega os pedidos ENTREGUES num resumo de economia. `now` é injetável para
 * manter os últimos-6-meses determinísticos em teste.
 */
export function computeSavings(
  orders: SavingsOrderInput[],
  now: Date = new Date(),
): SavingsSummary {
  const monthMap = new Map<string, { total: number; toolCount: number }>();
  let totalTools = 0;
  let totalSpent = 0;

  for (const order of orders) {
    const monthKey = format(new Date(order.created_at), 'yyyy-MM');
    const toolCount = contarFerramentas(order.items);
    const orderTotal = Number(order.total) || 0;

    const existing = monthMap.get(monthKey) || { total: 0, toolCount: 0 };
    monthMap.set(monthKey, {
      total: existing.total + orderTotal,
      toolCount: existing.toolCount + toolCount,
    });

    totalTools += toolCount;
    totalSpent += orderTotal;
  }

  const monthlyData: SavingsMonthly[] = [];
  for (let i = 5; i >= 0; i--) {
    const date = subMonths(now, i);
    const key = format(date, 'yyyy-MM');
    const monthData = monthMap.get(key) || { total: 0, toolCount: 0 };
    const newToolCost = monthData.toolCount * AVG_NEW_TOOL_COST;
    const savings = newToolCost - monthData.total;

    monthlyData.push({
      month: format(date, 'MMM', { locale: ptBR }),
      sharpeningCost: monthData.total,
      newToolCost,
      savings: savings > 0 ? savings : 0,
      toolCount: monthData.toolCount,
    });
  }

  const totalNewCost = totalTools * AVG_NEW_TOOL_COST;
  const totalSavings = totalNewCost - totalSpent;
  const savingsPercent =
    totalTools > 0 ? Math.round((totalSavings / totalNewCost) * 100) : 0;

  return { monthlyData, totalTools, totalSpent, totalSavings, savingsPercent };
}
