// Card de KPI do PosicaoAgora.
// Extraído verbatim de src/components/financeiro/cashflow/PosicaoAgora.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { fmtCompact } from './format';

export function MetricCard({ title, value, subtitle, positive, icon: Icon }: {
  title: string; value: number; subtitle: string; positive: boolean; icon: React.ElementType;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground font-medium">{title}</p>
            <p className={`text-lg font-bold mt-1 ${positive ? 'text-status-success' : 'text-status-error'}`}>
              {fmtCompact(value)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
          </div>
          <div className={`p-2 rounded-lg ${positive ? 'bg-status-success-bg' : 'bg-status-error-bg'}`}>
            <Icon className={`w-4 h-4 ${positive ? 'text-status-success' : 'text-status-error'}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
