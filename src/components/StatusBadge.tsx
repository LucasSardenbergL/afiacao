import { cn } from '@/lib/utils';
import { OrderStatus, ORDER_STATUS } from '@/types';

interface StatusBadgeProps {
  status: OrderStatus;
  size?: 'sm' | 'md' | 'lg';
}

export function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const statusInfo = ORDER_STATUS[status];

  const sizeClasses = {
    sm: 'text-[10px] px-2 py-0.5',
    md: 'text-xs px-2.5 py-1',
    lg: 'text-sm px-3 py-1.5',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-medium',
        sizeClasses[size]
      )}
      style={{
        backgroundColor: `color-mix(in srgb, ${statusInfo.color.replace('bg-', 'var(--')}), transparent 85%)`,
      }}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full', statusInfo.color)} />
      {statusInfo.label}
    </span>
  );
}

// Simplified version with direct color mapping
export function StatusBadgeSimple({ status, size = 'md' }: StatusBadgeProps) {
  const statusInfo = ORDER_STATUS[status];

  const sizeClasses = {
    sm: 'text-[10px] px-2 py-0.5',
    md: 'text-xs px-2.5 py-1',
    lg: 'text-sm px-3 py-1.5',
  };

  const colorMap: Record<string, string> = {
    'bg-blue-500': 'bg-blue-100 text-blue-800',
    'bg-amber-500': 'bg-amber-100 text-amber-800',
    'bg-purple-500': 'bg-purple-100 text-purple-800',
    'bg-emerald-500': 'bg-emerald-100 text-emerald-800',
    'bg-emerald-600': 'bg-emerald-100 text-emerald-800',
    'bg-primary': 'bg-red-100 text-red-800',
    'bg-indigo-500': 'bg-indigo-100 text-indigo-800',
  };

  const dotColorMap: Record<string, string> = {
    'bg-blue-500': 'bg-blue-500',
    'bg-amber-500': 'bg-amber-500',
    'bg-purple-500': 'bg-purple-500',
    'bg-emerald-500': 'bg-emerald-500',
    'bg-emerald-600': 'bg-emerald-600',
    'bg-primary': 'bg-primary',
    'bg-indigo-500': 'bg-indigo-500',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-medium',
        sizeClasses[size],
        colorMap[statusInfo.color] || 'bg-gray-100 text-gray-800'
      )}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full', dotColorMap[statusInfo.color] || 'bg-gray-500')} />
      {statusInfo.label}
    </span>
  );
}
