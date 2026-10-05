// Faixa de KPIs (faturamento 12m/90d, ticket médio, última compra) do Customer 360.
// Extraída de src/pages/Customer360.tsx (god-component split).
import { TrendingUp, Calendar, ShoppingBag, Clock } from 'lucide-react';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { KpiCard } from './components';
import { formatBRL } from './format';
import {
  motivoSemMetrica,
  rotuloConsolidado,
  rotuloFaturamento12m,
  rotuloMetrica,
  rotuloUltimaCompra,
} from './kpi-rotulos';
import type { CustomerMetrics, CustomerScore, Faturamento12m, LeituraKpi } from './viewTypes';

export function CustomerKpiStrip({
  faturamento12m, metricas, score: s,
}: {
  faturamento12m: LeituraKpi<Faturamento12m>;
  metricas: LeituraKpi<CustomerMetrics>;
  score: CustomerScore;
}) {
  const m = metricas.emMaos ? metricas.valor : null;
  const fatTrend90 =
    m?.faturamento_90d && m?.faturamento_prev_90d && m.faturamento_prev_90d > 0
      ? ((m.faturamento_90d - m.faturamento_prev_90d) / m.faturamento_prev_90d) * 100
      : null;

  const fat12 = rotuloFaturamento12m(faturamento12m);
  const semMetrica = motivoSemMetrica(metricas);
  const ultima = rotuloUltimaCompra(metricas);
  const consolidado = rotuloConsolidado(metricas);
  // Valor em mãos cuja atualização falhou: os números FICAM e o aviso declara a idade deles.
  const velho12m = faturamento12m.emMaos ? faturamento12m.desatualizado : null;
  const velhoConsolidado = metricas.emMaos ? metricas.desatualizado : null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Faturamento 12m" value={fat12.value} hint={fat12.hint} icon={TrendingUp} />
        <KpiCard
          label="Faturamento 90d"
          value={rotuloMetrica(metricas, (x) => (x.faturamento_90d == null ? '—' : formatBRL(x.faturamento_90d)))}
          trend={
            fatTrend90 !== null
              ? { value: fatTrend90, label: 'vs. 90d anteriores' }
              : undefined
          }
          hint={semMetrica ?? (m && fatTrend90 === null ? `${m.pedidos_90d} pedidos` : undefined)}
          icon={Calendar}
        />
        <KpiCard
          label="Ticket médio (90d)"
          value={rotuloMetrica(metricas, (x) => (x.ticket_medio_90d == null ? '—' : formatBRL(x.ticket_medio_90d)))}
          hint={semMetrica ?? (s?.avg_repurchase_interval ? `Recompra ~${Math.round(s.avg_repurchase_interval)}d` : undefined)}
          icon={ShoppingBag}
        />
        <KpiCard label="Última compra" value={ultima.value} hint={ultima.hint} icon={Clock} />
      </div>
      {velho12m && (
        <AvisoLeituraFalhou
          oque="a leitura mais recente do faturamento 12m"
          estado={velho12m}
          testId="aviso-c360-faturamento-12m"
          className="mb-0"
        />
      )}
      {velhoConsolidado && (
        <AvisoLeituraFalhou
          oque="a leitura mais recente de 90d, ticket médio e última compra"
          estado={velhoConsolidado}
          testId="aviso-c360-consolidado"
          className="mb-0"
        />
      )}
      {consolidado && <p className="text-xs text-muted-foreground">{consolidado}</p>}
    </div>
  );
}
