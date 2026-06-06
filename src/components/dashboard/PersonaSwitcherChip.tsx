import { ChevronDown, Check, Eye } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useImpersonationTargets } from '@/hooks/useImpersonationTargets';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';

export function PersonaSwitcherChip() {
  const { isMaster } = useAuth();
  const { data: targets = [], isLoading } = useImpersonationTargets();
  const { isImpersonating, target, startImpersonation, stopImpersonation } = useImpersonation();

  if (!isMaster) return null; // a lente é master-only

  const label = isImpersonating && target ? target.nome : 'você';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-background/60 backdrop-blur border border-border/60 text-xs font-medium text-foreground hover:bg-background/80 transition-colors"
        >
          <Eye className="w-3 h-3 opacity-70" />
          <span className="text-muted-foreground">Ver como:</span>
          <span>{label}</span>
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="p-3 border-b border-border">
          <p className="text-xs font-semibold text-foreground">Ver o app como outra pessoa</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Menu, navegação e dados ficam como os dela. Somente leitura.
          </p>
        </div>
        <div className="py-1 max-h-72 overflow-y-auto">
          <button
            onClick={() => stopImpersonation()}
            className={cn('w-full text-left px-3 py-2 hover:bg-muted transition-colors flex items-start gap-2', !isImpersonating && 'bg-muted/60')}
          >
            <Check className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', !isImpersonating ? 'opacity-100' : 'opacity-0')} />
            <div className="text-sm font-medium text-foreground">Você (master)</div>
          </button>
          {isLoading && <div className="px-3 py-2 text-[11px] text-muted-foreground">Carregando…</div>}
          {targets.map((t) => {
            const active = isImpersonating && target?.id === t.id;
            return (
              <button
                key={t.id}
                onClick={() => startImpersonation(t, 'Lente via chip do dashboard')}
                className={cn('w-full text-left px-3 py-2 hover:bg-muted transition-colors flex items-start gap-2', active && 'bg-muted/60')}
              >
                <Check className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', active ? 'opacity-100' : 'opacity-0')} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground">{t.nome}</div>
                  {t.grupo && <div className="text-[11px] text-muted-foreground">{t.grupo}</div>}
                </div>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
