// Faixa de KPIs (faturamento 12m/90d, ticket médio, última compra) do Customer 360.
// Extraída de src/pages/Customer360.tsx (god-component split).
import { TrendingUp, Calendar, ShoppingBag, Clock } from 'lucide-react';
import { KpiCard } from './components';
import { formatBRL, formatDateOrDash } from './format';
import { rotuloFaturamento12m, rotuloMetrica, rotuloUltimaCompra } from './kpi-rotulos';
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

  const fat12 = rotuloFaturamento12m(revenueDerived);
  const indisp = revenueDerived.metricasIndisponiveis;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <KpiCard label="Faturamento 12m" value={fat12.value} hint={fat12.hint} icon={TrendingUp} />
      <KpiCard
        label="Faturamento 90d"
        value={rotuloMetrica(m, indisp, (x) => (x.faturamento_90d == null ? '—' : formatBRL(x.faturamento_90d)))}
        trend={
          fatTrend90 !== null
            ? { value: fatTrend90, label: 'vs. 90d anteriores' }
            : undefined
        }
        hint={indisp ? 'indisponível' : m && fatTrend90 === null ? `${m.pedidos_90d} pedidos` : undefined}
        icon={Calendar}
      />
      <KpiCard
        label="Ticket médio (90d)"
        value={rotuloMetrica(m, indisp, (x) => (x.ticket_medio_90d == null ? '—' : formatBRL(x.ticket_medio_90d)))}
        hint={s?.avg_repurchase_interval ? `Recompra ~${Math.round(s.avg_repurchase_interval)}d` : undefined}
        icon={ShoppingBag}
      />
      <KpiCard
        label="Última compra"
        value={rotuloUltimaCompra(m, indisp)}
        hint={
          m?.intervalo_medio_dias
            ? `Intervalo médio ~${Math.round(m.intervalo_medio_dias)}d`
            : m?.ultima_compra_data
              ? formatDateOrDash(m.ultima_compra_data)
              : undefined
        }
        icon={Clock}
      />
    </div>
  );
}
