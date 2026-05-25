// Header do Cockpit financeiro (título + regime toggle + badges de confiabilidade).
// Extraído verbatim de src/pages/FinanceiroCockpit.tsx (god-component split).
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import { RegimeToggle } from '@/components/financeiro/RegimeToggle';
import { TransparencyBadge } from './TransparencyBadge';
import type { FinConfiabilidadeRow } from './types';

interface CockpitHeaderProps {
  confiabilidade: FinConfiabilidadeRow[];
}

export function CockpitHeader({ confiabilidade }: CockpitHeaderProps) {
  return (
    <div className="relative bg-cockpit-hero noise rounded-lg border border-border px-6 py-8 flex items-center justify-between flex-wrap gap-3 overflow-hidden">
      <div className="relative">
        <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium mb-1.5">
          Financeiro · Cockpit
        </p>
        <h1 className="font-display" style={{ fontSize: '2.25rem', fontWeight: 500, letterSpacing: '-0.04em', lineHeight: 1.1 }}>
          Visão consolidada
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5 tabular-nums">
          {new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}
        </p>
      </div>
      {/* Global transparency + regime toggle */}
      <div className="relative flex flex-col items-end gap-3">
        <RegimeToggle />
        {confiabilidade.length > 0 && (
          <div className="flex flex-col items-end gap-1">
            {confiabilidade.map(c => (
              <div key={c.company} className="flex items-center gap-2">
                <span className="text-xs font-medium">{COMPANIES[c.company as Company]?.shortName}</span>
                <TransparencyBadge conf={c} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
