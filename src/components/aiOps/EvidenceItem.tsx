// Item de evidência de uma decisão de IA.
// Extraído verbatim de src/pages/AIops.tsx (god-component split).
import { AlertTriangle, TrendingDown, Clock } from 'lucide-react';
import type { Evidence } from './types';

export function EvidenceItem({ evidence }: { evidence: Evidence }) {
  const colorMap = {
    critical: 'text-destructive',
    warning: 'text-status-warning',
    info: 'text-muted-foreground',
  };
  const iconMap = {
    critical: AlertTriangle,
    warning: TrendingDown,
    info: Clock,
  };
  const Icon = iconMap[evidence.type];

  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${colorMap[evidence.type]}`} />
      <div>
        <span className="font-medium">{evidence.label}:</span>{' '}
        <span className={colorMap[evidence.type]}>{evidence.value}</span>
      </div>
    </div>
  );
}
