// Card de aging (faixas de vencimento) do dashboard financeiro.
// Extraído de src/pages/FinanceiroDashboard.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fmt, fmtCompact } from '@/components/financeiro/dashboard/format';
import type { AgingData } from '@/services/financeiroService';

export function AgingCard({ title, data }: { title: string; data: AgingData | null; type: 'receber' | 'pagar' }) {
  if (!data) return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent><Skeleton className="h-40" /></CardContent>
    </Card>
  );

  const total =
    data.a_vencer_valor +
    data.vencido_1_30_valor +
    data.vencido_31_60_valor +
    data.vencido_61_90_valor +
    data.vencido_90_plus_valor;

  const bars = [
    { label: 'A vencer', value: data.a_vencer_valor, qtd: data.a_vencer_qtd, color: 'bg-status-info' },
    { label: '1-30 dias', value: data.vencido_1_30_valor, qtd: data.vencido_1_30_qtd, color: 'bg-status-warning' },
    { label: '31-60 dias', value: data.vencido_31_60_valor, qtd: data.vencido_31_60_qtd, color: 'bg-status-warning-bold' },
    { label: '61-90 dias', value: data.vencido_61_90_valor, qtd: data.vencido_61_90_qtd, color: 'bg-status-error' },
    { label: '+90 dias', value: data.vencido_90_plus_valor, qtd: data.vencido_90_plus_qtd, color: 'bg-status-error' },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">Total: {fmt(total)}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {bars.map(b => (
          <div key={b.label} className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">{b.label} ({b.qtd})</span>
              <span className="font-medium">{fmtCompact(b.value)}</span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full ${b.color} transition-all`}
                style={{ width: total > 0 ? `${Math.max((b.value / total) * 100, 1)}%` : '0%' }}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
