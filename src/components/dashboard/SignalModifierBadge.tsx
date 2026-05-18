import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { TrendingUp, AlertTriangle, Target, Activity } from 'lucide-react';
import type { SignalModifier } from '@/lib/scoring/types';

const KIND_META: Record<string, { icon: typeof TrendingUp; color: string; emoji: string }> = {
  competitor_mentioned: { icon: AlertTriangle, color: 'text-status-error', emoji: '⚠' },
  risk_high: { icon: AlertTriangle, color: 'text-status-error', emoji: '⚠' },
  price_objection_high: { icon: AlertTriangle, color: 'text-status-error', emoji: '⚠' },
  opportunity_upsell: { icon: TrendingUp, color: 'text-status-success', emoji: '↑' },
  desired_outcome: { icon: Target, color: 'text-status-info', emoji: '◎' },
  close_attempted_no_close: { icon: Activity, color: 'text-status-warning', emoji: '!' },
};

/**
 * Badge compacto na linha do cliente em AgendaTodayList mostrando o sinal
 * dominante (maior |delta * decayedWeight|) e indicando quantos outros sinais
 * estão ativos. Tooltip mostra breakdown completo.
 */
export function SignalModifierBadge({ modifier, totalSignals }: { modifier: SignalModifier; totalSignals: number }) {
  const meta = KIND_META[modifier.kind] ?? { icon: Activity, color: 'text-muted-foreground', emoji: '·' };
  const Icon = meta.icon;
  const days = modifier.daysSince;
  const dayLabel = days === 0 ? 'hoje' : days === 1 ? 'ontem' : `há ${days}d`;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className={`text-2xs gap-1 ${meta.color} border-current/30`}>
            <Icon className="w-3 h-3" />
            <span className="font-medium">{meta.emoji}</span>
            <span className="truncate max-w-[120px]">{modifier.reason}</span>
            {totalSignals > 1 && <span className="opacity-60">+{totalSignals - 1}</span>}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <div className="space-y-1 text-xs">
            <div className="font-medium">{modifier.reason}</div>
            <div className="text-muted-foreground">
              Δ {modifier.delta > 0 ? '+' : ''}{modifier.delta} pts em {modifier.dimension} ·
              peso {(modifier.decayedWeight * 100).toFixed(0)}% · {dayLabel}
            </div>
            {totalSignals > 1 && (
              <div className="text-muted-foreground border-t border-border/40 pt-1 mt-1">
                +{totalSignals - 1} outros sinais ativos
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
