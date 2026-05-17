import { ArrowUp, ArrowDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Company } from '@/contexts/CompanyContext';

export interface KpiSpec {
  label: string;
  value: string;
  /** Delta em % (positivo = ↑ verde, negativo = ↓ vermelho). */
  deltaPct?: number;
  /** Breakdown por empresa (sum). Mostra dots quando informado. */
  breakdown?: { company: Company; share: number }[];
}

const COLOR_VAR: Record<Company, string> = {
  colacor: '--company-colacor',
  oben: '--company-oben',
  colacor_sc: '--company-sc',
};

export function CockpitKpiRow({ kpis }: { kpis: KpiSpec[] }) {
  return (
    <div className="grid grid-cols-3 gap-3 px-4 py-4 border-b border-border/60">
      {kpis.map((k) => (
        <div key={k.label} className="min-w-0">
          <div className="kpi-value text-xl text-foreground truncate" title={k.value}>{k.value}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5 truncate">
            {k.label}
          </div>
          <div className="mt-1.5 flex items-center gap-1">
            {typeof k.deltaPct === 'number' && (
              <span
                className={cn(
                  'inline-flex items-center text-[10px] font-semibold',
                  k.deltaPct >= 0 ? 'text-status-success-bold' : 'text-status-error-bold',
                )}
              >
                {k.deltaPct >= 0 ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />}
                {Math.abs(k.deltaPct).toFixed(0)}%
              </span>
            )}
            {k.breakdown && k.breakdown.length > 0 && (
              <BreakdownDots breakdown={k.breakdown} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function BreakdownDots({ breakdown }: { breakdown: NonNullable<KpiSpec['breakdown']> }) {
  const total = breakdown.reduce((s, b) => s + b.share, 0) || 1;
  const tooltip = breakdown
    .map((b) => `${b.company}: ${Math.round((b.share / total) * 100)}%`)
    .join(' · ');
  return (
    <div className="inline-flex gap-0.5" title={tooltip} aria-label={tooltip}>
      {breakdown.map((b) => (
        <span
          key={b.company}
          className="h-1 rounded-sm"
          style={{
            backgroundColor: `hsl(var(${COLOR_VAR[b.company]}))`,
            width: `${Math.max(6, (b.share / total) * 24)}px`,
          }}
        />
      ))}
    </div>
  );
}
