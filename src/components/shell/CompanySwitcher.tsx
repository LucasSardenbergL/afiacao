import { Building2, Check, ChevronsUpDown } from 'lucide-react';
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

const COMPANY_HINT: Record<Company, string> = {
  colacor: 'Indústria',
  oben: 'Distribuidora',
  colacor_sc: 'Serviços',
};

export function CompanySwitcher() {
  const { activeCompany, setActiveCompany, companyInfo } = useCompany();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-2 h-8 px-2.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <Building2 className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{companyInfo.shortName}</span>
          <ChevronsUpDown className="w-3 h-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
          Empresa ativa
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ALL_COMPANIES.map((id) => {
          const info = COMPANIES[id];
          const active = id === activeCompany;
          return (
            <DropdownMenuItem
              key={id}
              onClick={() => setActiveCompany(id)}
              className="flex items-center gap-2"
            >
              <Building2 className="w-4 h-4 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{info.shortName}</div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {COMPANY_HINT[id]} · regime {info.regime}
                </div>
              </div>
              <Check className={cn('w-4 h-4', active ? 'opacity-100 text-primary' : 'opacity-0')} />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
