// Cards auxiliares do Customer360View (MetricCard + ScoreItem).
// Extraídos verbatim de src/pages/AdminCustomers.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

export function MetricCard({ icon: Icon, label, value, danger }: { icon: LucideIcon; label: string; value: string; danger?: boolean }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <Icon className={cn('w-3.5 h-3.5', danger ? 'text-destructive' : 'text-muted-foreground')} />
          <span className="text-[11px] text-muted-foreground">{label}</span>
        </div>
        <p className={cn('text-lg font-semibold', danger && 'text-destructive')}>{value}</p>
      </CardContent>
    </Card>
  );
}

export function ScoreItem({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="text-center">
      <p className="text-[10px] text-muted-foreground mb-0.5">{label}</p>
      <p className={cn('text-sm font-semibold', danger && 'text-destructive')}>{value}</p>
    </div>
  );
}
