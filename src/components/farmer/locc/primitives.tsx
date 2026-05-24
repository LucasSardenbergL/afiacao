// Primitivos de apresentação compartilhados da tela FarmerLOCC.
// Extraídos verbatim de src/pages/FarmerLOCC.tsx (god-component split).
import { Skeleton } from '@/components/ui/skeleton';

// Skeleton placeholder for unvisited tabs
export const TabSkeleton = () => (
  <div className="space-y-3 mt-3">
    <Skeleton className="h-24 w-full rounded-lg" />
    <Skeleton className="h-16 w-full rounded-lg" />
    <Skeleton className="h-16 w-full rounded-lg" />
  </div>
);

export const MetricRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between">
    <span className="text-xs text-muted-foreground">{label}</span>
    <span className="text-xs font-semibold">{value}</span>
  </div>
);

export const WeightBar = ({ label, value, color = 'bg-primary' }: { label: string; value: number; color?: string }) => (
  <div className="mb-1">
    <div className="flex items-center justify-between">
      <span className="text-[10px]">{label}</span>
      <span className="text-[10px] font-semibold">{value.toFixed(0)}%</span>
    </div>
    <div className="w-full bg-muted rounded-full h-1.5">
      <div className={`${color} h-1.5 rounded-full transition-all`} style={{ width: `${value}%` }} />
    </div>
  </div>
);
