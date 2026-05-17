import { useNavigate } from 'react-router-dom';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { track } from '@/lib/analytics';
import type { ZoneId } from '@/lib/dashboard/persona-config';

export interface TopListItem {
  id: string;
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  path: string;
  itemType: string;
  badge?: { label: string; intent?: 'warning' | 'error' | 'success' | 'info' };
}

const BADGE_CLASS: Record<NonNullable<NonNullable<TopListItem['badge']>['intent']>, string> = {
  warning: 'text-status-warning-bold bg-status-warning-bg',
  error: 'text-status-error-bold bg-status-error-bg',
  success: 'text-status-success-bold bg-status-success-bg',
  info: 'text-status-info-bold bg-status-info-bg',
};

export function CockpitTopList({
  zone,
  items,
  emptyLabel,
}: {
  zone: ZoneId;
  items: TopListItem[];
  emptyLabel: string;
}) {
  const navigate = useNavigate();

  if (items.length === 0) {
    return (
      <div className="flex-1 px-4 py-4 text-center text-xs text-muted-foreground italic">
        {emptyLabel}
      </div>
    );
  }

  return (
    <ul className="flex-1 overflow-y-auto">
      {items.slice(0, 3).map((it) => {
        const Icon = it.icon;
        return (
          <li key={it.id}>
            <button
              onClick={() => {
                track('dashboard.zone.list_item_clicked', { zone, item_type: it.itemType, item_id: it.id });
                navigate(it.path);
              }}
              className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-muted/50 transition-colors border-b border-border/40 last:border-0"
            >
              {Icon && <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-foreground truncate">{it.title}</div>
                {it.subtitle && (
                  <div className="text-[10px] text-muted-foreground truncate">{it.subtitle}</div>
                )}
              </div>
              {it.badge && (
                <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded', BADGE_CLASS[it.badge.intent ?? 'info'])}>
                  {it.badge.label}
                </span>
              )}
              <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
