import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type Variant = 'cockpit' | 'list' | 'form' | 'detail' | 'auto';

interface PageSkeletonProps {
  variant?: Variant;
  className?: string;
}

/**
 * Esqueleto contextual de página — substitui spinner genérico no Suspense fallback.
 * Reduz CLS percebido e mantém a estrutura visual durante load.
 *
 * Variantes:
 *  - cockpit: header + 3 KPIs + tabela densa (CFO, Cockpit Reposição)
 *  - list: filtros + cards/linhas (SalesOrders, AdminCustomers)
 *  - form: header + steps + campos (UnifiedOrder, Conferência)
 *  - detail: header + sections (OrderDetail)
 *  - auto: padrão neutro (default do Suspense)
 */
export function PageSkeleton({ variant = 'auto', className }: PageSkeletonProps) {
  switch (variant) {
    case 'cockpit':
      return (
        <div className={cn('space-y-4 pb-24', className)}>
          <Skeleton className="h-8 w-64" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
          <Skeleton className="h-72 w-full" />
        </div>
      );
    case 'list':
      return (
        <div className={cn('space-y-3 pb-6', className)}>
          <div className="flex items-center justify-between">
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-9 w-32" />
          </div>
          <Skeleton className="h-9 w-full" />
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-md" />
            ))}
          </div>
        </div>
      );
    case 'form':
      return (
        <div className={cn('space-y-4 pb-6 max-w-3xl mx-auto', className)}>
          <Skeleton className="h-8 w-56" />
          <div className="flex gap-2">
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-6 w-16" />
          </div>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      );
    case 'detail':
      return (
        <div className={cn('space-y-4 pb-6', className)}>
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      );
    case 'auto':
    default:
      return (
        <div className={cn('flex flex-col gap-4 p-6', className)}>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      );
  }
}
