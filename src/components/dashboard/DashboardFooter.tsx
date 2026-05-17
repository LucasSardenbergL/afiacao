import { Keyboard } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PersonaSwitcherChip } from './PersonaSwitcherChip';
import { CompanyChip } from './CompanyChip';

export function DashboardFooter() {
  return (
    <footer className="border-t border-border mt-2">
      <div className="max-w-7xl mx-auto px-4 lg:px-6 py-3 flex items-center justify-between gap-4 flex-wrap text-xs text-muted-foreground">
        <div className="flex items-center gap-2 flex-wrap">
          <PersonaSwitcherChip />
          <CompanyChip />
        </div>
        <div className="flex items-center gap-3 font-mono text-[11px]">
          <span className="inline-flex items-center gap-1">
            <Keyboard className="w-3 h-3" />
            <kbd className="px-1 rounded bg-muted">?</kbd> atalhos
          </span>
          <span>
            <kbd className="px-1 rounded bg-muted">⌘K</kbd> busca
          </span>
          <span>
            <kbd className="px-1 rounded bg-muted">r</kbd> recarregar
          </span>
          <span>
            <kbd className="px-1 rounded bg-muted">g d</kbd> dashboard
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button disabled className="opacity-50 cursor-not-allowed">
                Personalizar dashboard
              </button>
            </TooltipTrigger>
            <TooltipContent>Em breve</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </footer>
  );
}
