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

/**
 * Cada empresa tem identidade visual mínima — monograma colorido em quadrado 20×20.
 * Cores dessaturadas alinhadas à paleta low-fatigue (ver docs/visual-direction/04-identidade.md).
 */
const COMPANY_VISUAL: Record<Company, { letter: string; bg: string; hint: string }> = {
  colacor:    { letter: 'C', bg: 'hsl(0 0% 9%)',       hint: 'Indústria' },
  oben:       { letter: 'O', bg: 'hsl(212 80% 35%)',   hint: 'Distribuidora' },
  colacor_sc: { letter: 'S', bg: 'hsl(142 50% 32%)',   hint: 'Serviços' },
};

function CompanyMonogram({ id, size = 20 }: { id: Company; size?: number }) {
  const v = COMPANY_VISUAL[id];
  return (
    <div
      className="rounded-md flex items-center justify-center font-semibold text-white shrink-0"
      style={{
        width: size,
        height: size,
        backgroundColor: v.bg,
        fontSize: size <= 20 ? 11 : 13,
        letterSpacing: '-0.02em',
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
          className="inline-flex items-center gap-2 h-8 px-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <CompanyMonogram id={activeCompany} size={20} />
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
              onClick={() => setActiveCompany(id)}
              className="flex items-center gap-3 py-2"
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
