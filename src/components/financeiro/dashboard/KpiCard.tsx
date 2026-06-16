// Card de KPI do dashboard financeiro.
// Extraído de src/pages/FinanceiroDashboard.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import type { LucideIcon } from 'lucide-react';
import { fmtCompact } from '@/components/financeiro/dashboard/format';

export function KpiCard({ title, value, icon: Icon, color, bgColor, subtitle, subtitleColor }: {
  title: string;
  value: number;
  icon: LucideIcon;
  color: string;
  bgColor: string;
  subtitle?: string;
  subtitleColor?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground font-medium">{title}</p>
            <p className={`text-lg kpi-value mt-1 ${color}`}>{fmtCompact(value)}</p>
            {subtitle && (
              <p className={`text-xs mt-1 ${subtitleColor || 'text-muted-foreground'}`}>{subtitle}</p>
            )}
          </div>
          <div className={`p-2 rounded-lg ${bgColor}`}>
            <Icon className={`w-4 h-4 ${color}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
