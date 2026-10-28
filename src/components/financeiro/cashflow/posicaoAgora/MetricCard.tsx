// Card de KPI do PosicaoAgora.
// Extraído verbatim de src/components/financeiro/cashflow/PosicaoAgora.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { fmtCompact } from './format';

export function MetricCard({ title, value, subtitle, positive, icon: Icon }: {
  title: string; value: number | null; subtitle: string; positive: boolean; icon: React.ElementType;
}) {
  // null = indisponível (ex.: saldo CC sem extrato fresco) → "—" neutro, nunca R$ 0 colorido.
  const indisponivel = value == null;
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground font-medium">{title}</p>
            <p className={`text-lg font-bold mt-1 ${indisponivel ? 'text-muted-foreground' : positive ? 'text-status-success' : 'text-status-error'}`}>
              {indisponivel ? '—' : fmtCompact(value)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
          </div>
          <div className={`p-2 rounded-lg ${indisponivel ? 'bg-muted' : positive ? 'bg-status-success-bg' : 'bg-status-error-bg'}`}>
            <Icon className={`w-4 h-4 ${indisponivel ? 'text-muted-foreground' : positive ? 'text-status-success' : 'text-status-error'}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
