import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function CockpitCardHeader({
  icon: Icon,
  title,
  caption,
  isLive,
}: {
  icon: LucideIcon;
  title: string;
  caption: string;
  isLive: boolean;
}) {
  return (
    <header className="flex items-start justify-between px-4 pt-4 pb-3 border-b border-border/60">
      <div className="flex items-start gap-2.5 min-w-0">
        <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4 text-foreground" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground truncate">{title}</h3>
          <p className="text-[11px] text-muted-foreground truncate">{caption}</p>
        </div>
      </div>
      <LiveBadge isLive={isLive} />
    </header>
  );
}

function LiveBadge({ isLive }: { isLive: boolean }) {
  if (!isLive) return null;
  return (
    <span
      aria-label="dados ao vivo"
      className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-status-success-bold shrink-0"
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className={cn('animate-ping-slow absolute inline-flex h-full w-full rounded-full bg-status-success-bold opacity-60')} />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-status-success-bold" />
      </span>
      Live
    </span>
  );
}
