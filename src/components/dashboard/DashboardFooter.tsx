import { Keyboard, Settings2 } from 'lucide-react';
import { useDashboardEditMode } from '@/contexts/DashboardEditModeContext';
import { cn } from '@/lib/utils';

export function DashboardFooter() {
  const { isEditMode, toggle } = useDashboardEditMode();

  return (
    <footer className="border-t border-border mt-2">
      <div className="max-w-7xl mx-auto px-4 lg:px-6 py-3 flex items-center justify-end gap-4 flex-wrap text-xs text-muted-foreground">
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
          <button
            type="button"
            onClick={toggle}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded transition-colors',
              isEditMode
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'hover:text-foreground hover:bg-muted',
            )}
            aria-pressed={isEditMode}
          >
            <Settings2 className="w-3 h-3" />
            {isEditMode ? 'Concluir' : 'Personalizar'}
          </button>
        </div>
      </div>
    </footer>
  );
}
