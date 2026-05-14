import { Check, ChevronsUpDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ALL_COMPANIES, COMPANIES, useCompany, type Company } from '@/contexts/CompanyContext';
import { cn } from '@/lib/utils';
import { track } from '@/lib/analytics';

/**
 * Identidade visual mínima por empresa via monogramas.
 * Cores agora vêm de tokens CSS (--company-*) — respeitam dark mode.
 *
 * Refinement: monograma com inner highlight (top 1px white/15) pra dar "depth"
 * tactile, e ring colorido sutil ao hover.
 */
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
        // Inner highlight pra "depth" tactile (top white at 15% via inset shadow)
        // + outer shadow muito sutil pra elevar do background
        'shadow-[inset_0_1px_0_hsl(0_0%_100%/0.18),0_1px_2px_hsl(0_0%_0%/0.06)]',
        withRingOnHover && 'group-hover:ring-2 group-hover:ring-offset-1 group-hover:ring-offset-background',
      )}
      style={{
        width: size,
        height: size,
        backgroundColor: `hsl(var(${v.tokenVar}))`,
        fontSize: size <= 20 ? 11 : 13,
        letterSpacing: '-0.02em',
        // Ring color via custom property pra hover
        // @ts-expect-error CSS var inline
        '--tw-ring-color': `hsl(var(${v.tokenVar}) / 0.4)`,
      }}
      aria-hidden
    >
      {v.letter}
    </div>
  );
}

export function CompanySwitcher() {
  const { activeCompany, setActiveCompany, companyInfo } = useCompany();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="group inline-flex items-center gap-2 h-8 px-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <CompanyMonogram id={activeCompany} size={20} withRingOnHover />
          <span className="hidden sm:inline">{companyInfo.shortName}</span>
          <ChevronsUpDown className="w-3 h-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
          Empresa ativa
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ALL_COMPANIES.map((id) => {
          const info = COMPANIES[id];
          const v = COMPANY_VISUAL[id];
          const active = id === activeCompany;
          return (
            <DropdownMenuItem
              key={id}
              onClick={() => {
                if (id !== activeCompany) {
                  track('company.changed', { from: activeCompany, to: id });
                }
                setActiveCompany(id);
              }}
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
