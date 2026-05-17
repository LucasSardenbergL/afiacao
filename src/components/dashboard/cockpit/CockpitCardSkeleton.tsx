import { Skeleton } from '@/components/ui/skeleton';

export function CockpitCardSkeleton() {
  return (
    <div className="flex-1 flex flex-col">
      <div className="grid grid-cols-3 gap-3 px-4 py-4 border-b border-border/60">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-2.5 w-12" />
          </div>
        ))}
      </div>
      <div className="flex-1 px-4 py-3 space-y-2">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
      </div>
    </div>
  );
}
