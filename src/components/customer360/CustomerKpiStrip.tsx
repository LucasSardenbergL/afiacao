// Faixa de KPIs (faturamento 12m/90d, ticket médio, última compra) do Customer 360.
// Extraída de src/pages/Customer360.tsx (god-component split).
import { TrendingUp, Calendar, ShoppingBag, Clock } from 'lucide-react';
import { KpiCard } from './components';
import { formatBRL, formatRelative, formatDateOrDash } from './format';
import type { RevenueDerived, CustomerMetrics, CustomerScore } from './viewTypes';

export function CustomerKpiStrip({
  revenueDerived, metrics: m, score: s,
}: {
  revenueDerived: RevenueDerived;
  metrics: CustomerMetrics;
  score: CustomerScore;
}) {
  const fatTrend90 =
    m?.faturamento_90d && m?.faturamento_prev_90d && m.faturamento_prev_90d > 0
      ? ((m.faturamento_90d - m.faturamento_prev_90d) / m.faturamento_prev_90d) * 100
      : null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <KpiCard
        label="Faturamento 12m"
        value={formatBRL(revenueDerived.last12)}
        hint={`${revenueDerived.orderCount12m} pedidos`}
        icon={TrendingUp}
      />
      <KpiCard
        label="Faturamento 90d"
        value={formatBRL(m?.faturamento_90d ?? 0)}
        trend={
          fatTrend90 !== null
            ? { value: fatTrend90, label: 'vs. 90d anteriores' }
            : undefined
        }
        hint={fatTrend90 === null ? `${m?.pedidos_90d ?? 0} pedidos` : undefined}
        icon={Calendar}
      />
      <KpiCard
        label="Ticket médio (90d)"
        value={formatBRL(m?.ticket_medio_90d ?? 0)}
        hint={s?.avg_repurchase_interval ? `Recompra ~${Math.round(s.avg_repurchase_interval)}d` : undefined}
        icon={ShoppingBag}
      />
      <KpiCard
        label="Última compra"
        value={
          m?.dias_desde_ultima_compra != null
            ? `${m.dias_desde_ultima_compra}d`
            : revenueDerived.lastOrderAt
              ? formatRelative(revenueDerived.lastOrderAt)
              : 'Nunca'
        }
        hint={
          m?.intervalo_medio_dias
            ? `Intervalo médio ~${Math.round(m.intervalo_medio_dias)}d`
            : revenueDerived.lastOrderAt
              ? formatDateOrDash(revenueDerived.lastOrderAt)
              : undefined
        }
        icon={Clock}
      />
    </div>
  );
}
