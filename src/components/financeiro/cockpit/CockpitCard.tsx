// Card grande de KPI do Cockpit (Caixa/Projetado/NCG).
// Extraído verbatim de src/pages/FinanceiroCockpit.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { LucideIcon } from 'lucide-react';

export function CockpitCard({ title, value, positive, icon: Icon, detail, detailColor, badge, onClick }: {
  title: string; value: string; positive: boolean; icon: LucideIcon;
  detail?: string; detailColor?: string; badge?: string; onClick?: () => void;
}) {
  return (
    <Card className={onClick ? 'cursor-pointer hover:bg-muted/30 transition-colors' : ''} onClick={onClick}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{title}</p>
            <p className={`kpi-value text-3xl mt-2 ${positive ? 'text-status-success' : 'text-status-error'}`}>{value}</p>
            {detail && (
              <p className={`text-xs mt-2 ${detailColor || 'text-muted-foreground'}`}>{detail}</p>
            )}
            {badge && (
              <Badge variant="outline" className="mt-2 text-[9px]">{badge}</Badge>
            )}
          </div>
          <div className={`p-2.5 rounded-md ${positive ? 'bg-status-success-bg' : 'bg-status-error-bg'}`}>
            <Icon className={`w-4 h-4 ${positive ? 'text-status-success' : 'text-status-error'}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
