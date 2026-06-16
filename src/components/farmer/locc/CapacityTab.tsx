// Aba "Capacidade" da tela FarmerLOCC (usa metrics do pai, sem hooks extras).
// Extraída verbatim de src/pages/FarmerLOCC.tsx (god-component split).
import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Activity, BarChart3 } from 'lucide-react';
import { type FarmerMetrics } from '@/hooks/useFarmerMetrics';
import { fmt, fmtDur } from './helpers';
import { MetricRow } from './primitives';

export const CapacityTab = memo(({ metrics }: { metrics: FarmerMetrics }) => (
  <>
    <Card>
      <CardHeader className="p-3 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity className="w-4 h-4" /> Motor de Capacidade
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0 space-y-2">
        <MetricRow label="T_call médio" value={fmtDur(metrics.avgCallDuration)} />
        <MetricRow label="T_follow médio" value={fmtDur(metrics.avgFollowUpDuration)} />
        <MetricRow label="N_attempts médio" value={metrics.avgAttemptsToContact.toFixed(1)} />
        <MetricRow label="T_total por contato" value={metrics.tTotal > 0 ? `${(metrics.tTotal * 60).toFixed(0)} min` : '-'} />
        <MetricRow label="Capacidade/Dia" value={`${Math.round(metrics.capacityPerDay)} ligações`} />
        <MetricRow label="Carteira Ideal" value={`${metrics.optimalClientsCount} clientes`} />
        <MetricRow label="Margem Incremental/Ligação" value={metrics.totalCalls > 0 ? fmt(metrics.totalMargin / metrics.totalCalls) : '-'} />
        <MetricRow label="Margem/Hora" value={fmt(metrics.marginPerHour)} />
        <MetricRow label="Taxa de Contato" value={`${metrics.contactRate.toFixed(1)}%`} />
        <MetricRow label="Total de Ligações" value={String(metrics.totalCalls)} />
        <MetricRow label="Dias de dados" value={`${metrics.daysOfData}`} />
      </CardContent>
    </Card>

    <Card>
      <CardHeader className="p-3 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <BarChart3 className="w-4 h-4" /> Conversão por Tipo
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0 space-y-2">
        <MetricRow label="Reativação" value={`${metrics.conversionByType.reativacao.toFixed(1)}%`} />
        <MetricRow label="Cross-sell" value={`${metrics.conversionByType.cross_sell.toFixed(1)}%`} />
        <MetricRow label="Up-sell" value={`${metrics.conversionByType.up_sell.toFixed(1)}%`} />
        <MetricRow label="Follow-up" value={`${metrics.conversionByType.follow_up.toFixed(1)}%`} />
      </CardContent>
    </Card>

    {!metrics.hasEnoughData && (
      <Card className="border-dashed">
        <CardContent className="p-3">
          <p className="text-xs text-muted-foreground">
            ⚡ Após <strong>30 dias</strong> de dados o sistema ajustará automaticamente.
            Progresso: {metrics.daysOfData}/30 dias.
          </p>
          <Progress value={(metrics.daysOfData / 30) * 100} className="h-2 mt-2" />
        </CardContent>
      </Card>
    )}
  </>
));
CapacityTab.displayName = 'CapacityTab';
