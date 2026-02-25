import { cn } from '@/lib/utils';
import { OrderStatus, ORDER_STATUS } from '@/types';

interface StatusBadgeProps {
  status: OrderStatus;
  size?: 'sm' | 'md' | 'lg';
}

/* Maps the legacy bg-color class from ORDER_STATUS to a semantic CSS class */
const semanticMap: Record<string, string> = {
  'bg-blue-500': 'status-progress',
  'bg-amber-500': 'status-pending',
  'bg-purple-500': 'status-purple',
  'bg-emerald-500': 'status-success',
  'bg-emerald-600': 'status-success',
  'bg-primary': 'status-progress',
  'bg-indigo-500': 'status-indigo',
};

const dotMap: Record<string, string> = {
  'bg-blue-500': 'bg-status-info',
  'bg-amber-500': 'bg-status-warning',
  'bg-purple-500': 'bg-status-purple',
  'bg-emerald-500': 'bg-status-success',
  'bg-emerald-600': 'bg-status-success',
  'bg-primary': 'bg-primary',
  'bg-indigo-500': 'bg-status-indigo',
};

const sizeClasses = {
  sm: 'text-[10px] px-2 py-0.5',
  md: 'text-xs px-2.5 py-1',
  lg: 'text-sm px-3 py-1.5',
};

export function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const statusInfo = ORDER_STATUS[status];
  const semantic = semanticMap[statusInfo.color] || 'status-progress';
  const dot = dotMap[statusInfo.color] || 'bg-muted-foreground';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-medium border',
        sizeClasses[size],
        semantic,
      )}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full', dot)} />
      {statusInfo.label}
    </span>
  );
}

/** @deprecated Use StatusBadge instead */
export const StatusBadgeSimple = StatusBadge;
