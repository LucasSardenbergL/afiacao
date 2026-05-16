import { ChevronDown, Check } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ALL_COMPANIES, COMPANIES, useCompany, type Company, type CompanySelection } from '@/contexts/CompanyContext';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/utils';

const COLOR_VAR: Record<Company, string> = {
  colacor: '--company-colacor',
  oben: '--company-oben',
  colacor_sc: '--company-sc',
};

export function CompanyChip() {
  const { selection, setSelection } = useCompany();

  const label =
    selection === 'all' ? 'Todas as empresas' : COMPANIES[selection].shortName;

  const handlePick = (next: CompanySelection) => {
    if (next === selection) return;
    track('dashboard.company.switched_from_dashboard', { from: selection, to: next });
    setSelection(next);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-background/60 backdrop-blur border border-border/60 text-xs font-medium text-foreground hover:bg-background/80 transition-colors"
        >
          <span className="text-muted-foreground">Empresa:</span>
          <span>{label}</span>
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <button
          onClick={() => handlePick('all')}
          className={cn(
            'w-full text-left px-2 py-1.5 hover:bg-muted rounded transition-colors flex items-center gap-2',
            selection === 'all' && 'bg-muted/60',
          )}
        >
          <Check className={cn('w-3.5 h-3.5', selection === 'all' ? 'opacity-100' : 'opacity-0')} />
          <div className="flex gap-0.5">
            {ALL_COMPANIES.map((id) => (
              <span key={id} className="w-3 h-3 rounded-sm" style={{ backgroundColor: `hsl(var(${COLOR_VAR[id]}))` }} />
            ))}
          </div>
          <span className="text-sm">Todas as empresas</span>
        </button>
        <div className="my-1 h-px bg-border" />
        {ALL_COMPANIES.map((id) => (
          <button
            key={id}
            onClick={() => handlePick(id)}
            className={cn(
              'w-full text-left px-2 py-1.5 hover:bg-muted rounded transition-colors flex items-center gap-2',
              selection === id && 'bg-muted/60',
            )}
          >
            <Check className={cn('w-3.5 h-3.5', selection === id ? 'opacity-100' : 'opacity-0')} />
            <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: `hsl(var(${COLOR_VAR[id]}))` }} />
            <span className="text-sm">{COMPANIES[id].shortName}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
