import { Check, ChevronsUpDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ALL_COMPANIES, COMPANIES, useCompany, type Company, type CompanySelection } from '@/contexts/CompanyContext';
import { cn } from '@/lib/utils';
import { track } from '@/lib/analytics';

const COMPANY_VISUAL: Record<Company, { letter: string; tokenVar: string; hint: string }> = {
  colacor:    { letter: 'C', tokenVar: '--company-colacor', hint: 'Indústria' },
  oben:       { letter: 'O', tokenVar: '--company-oben',    hint: 'Distribuidora' },
  colacor_sc: { letter: 'S', tokenVar: '--company-sc',      hint: 'Serviços' },
};

function CompanyMonogram({
  id,
  size = 20,
  withRingOnHover = false,
}: {
  id: Company;
  size?: number;
  withRingOnHover?: boolean;
}) {
  const v = COMPANY_VISUAL[id];
  return (
    <div
      className={cn(
        'rounded-md flex items-center justify-center font-semibold text-white shrink-0 transition-all',
        'shadow-[inset_0_1px_0_hsl(0_0%_100%/0.18),0_1px_2px_hsl(0_0%_0%/0.06)]',
        withRingOnHover && 'group-hover:ring-2 group-hover:ring-offset-1 group-hover:ring-offset-background',
      )}
      style={{
        width: size,
        height: size,
        backgroundColor: `hsl(var(${v.tokenVar}))`,
        fontSize: size <= 20 ? 11 : 13,
        letterSpacing: '-0.02em',
        // @ts-expect-error CSS var inline
        '--tw-ring-color': `hsl(var(${v.tokenVar}) / 0.4)`,
      }}
      aria-hidden
    >
      {v.letter}
    </div>
  );
}

function TripleMonogram({ size = 20 }: { size?: number }) {
  // Monograma triplo "Grupo" — 3 segmentos verticais com as cores das empresas.
  return (
    <div
      className="rounded-md overflow-hidden shrink-0 flex shadow-[inset_0_1px_0_hsl(0_0%_100%/0.18),0_1px_2px_hsl(0_0%_0%/0.06)]"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {ALL_COMPANIES.map((id) => (
        <div
          key={id}
          className="flex-1 h-full"
          style={{ backgroundColor: `hsl(var(${COMPANY_VISUAL[id].tokenVar}))` }}
        />
      ))}
    </div>
  );
}

export function CompanySwitcher() {
  const { selection, setSelection, companyInfo } = useCompany();

  const triggerLabel = selection === 'all' ? 'Todas' : companyInfo.shortName;
  const triggerVisual = selection === 'all'
    ? <TripleMonogram size={20} />
    : <CompanyMonogram id={selection} size={20} withRingOnHover />;

  const handleSelect = (next: CompanySelection) => {
    if (next !== selection) {
      track('company.changed', { from: selection, to: next });
    }
    setSelection(next);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="group inline-flex items-center gap-2 h-8 px-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          {triggerVisual}
          <span className="hidden sm:inline">{triggerLabel}</span>
          <ChevronsUpDown className="w-3 h-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
          Empresa ativa
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => handleSelect('all')}
          className="group flex items-center gap-3 py-2"
        >
          <TripleMonogram size={28} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">Todas as empresas</div>
            <div className="text-[11px] text-muted-foreground truncate">
              Grupo Colacor · agregado
            </div>
          </div>
          <Check className={cn('w-4 h-4', selection === 'all' ? 'opacity-100 text-foreground' : 'opacity-0')} />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {ALL_COMPANIES.map((id) => {
          const info = COMPANIES[id];
          const v = COMPANY_VISUAL[id];
          const active = id === selection;
          return (
            <DropdownMenuItem
              key={id}
              onClick={() => handleSelect(id)}
              className="group flex items-center gap-3 py-2"
            >
              <CompanyMonogram id={id} size={28} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{info.shortName}</div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {v.hint} · regime {info.regime}
                </div>
              </div>
              <Check className={cn('w-4 h-4', active ? 'opacity-100 text-foreground' : 'opacity-0')} />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
