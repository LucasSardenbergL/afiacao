import { Search } from 'lucide-react';
import { useCommandsRegistry } from './CommandsRegistry';
import { track } from '@/lib/analytics';

/**
 * Pill clicável no topbar que abre a CommandPalette.
 * Substitui a falta de affordance — descoberta visual do Cmd+K.
 */
function isMac() {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

export function CommandPaletteTrigger() {
  const { setOpen } = useCommandsRegistry();
  const mac = isMac();
  return (
    <button
      type="button"
      onClick={() => { track('cmdk.opened', { trigger: 'pill' }); setOpen(true); }}
      className="hidden md:inline-flex items-center gap-2 h-8 px-2.5 rounded-md border border-border bg-muted/40 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors min-w-[180px]"
      aria-label="Buscar e navegar"
    >
      <Search className="w-3.5 h-3.5" />
      <span className="flex-1 text-left">Buscar...</span>
      <kbd className="px-1.5 py-0.5 rounded bg-card text-[10px] font-mono border border-border">
        {mac ? '⌘K' : 'Ctrl+K'}
      </kbd>
    </button>
  );
}
