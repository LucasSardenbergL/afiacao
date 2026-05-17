import { ChevronDown, Check, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';
import { PERSONAS, PERSONA_CONFIG, type Persona } from '@/lib/dashboard/persona-config';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/utils';

const SOURCE_LABEL: Record<string, string> = {
  manual: 'definido por você',
  commercial_role: 'via cargo comercial',
  sales_only: 'via restrição de CPF',
  inference: 'via inferência de uso',
  default: 'padrão',
};

export function PersonaSwitcherChip() {
  const { persona, source, override, setOverride, clearOverride } = useDashboardPersonaContext();
  const config = PERSONA_CONFIG[persona];

  const handlePick = (next: Persona) => {
    if (next === persona) return;
    track('dashboard.persona.switched', { from: persona, to: next, source: 'manual' });
    setOverride(next);
  };

  const handleClear = () => {
    if (!override) return;
    track('dashboard.persona.switched', { from: persona, to: 'auto', source: 'cleared' });
    clearOverride();
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-background/60 backdrop-blur border border-border/60 text-xs font-medium text-foreground hover:bg-background/80 transition-colors"
        >
          <span className="text-muted-foreground">Visão:</span>
          <span>{config.label}</span>
          <span className="text-muted-foreground">· {SOURCE_LABEL[source]}</span>
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="p-3 border-b border-border">
          <p className="text-xs font-semibold text-foreground">Trocar visão</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            A ordem dos cards e a ação prioritária mudam conforme a persona.
          </p>
        </div>
        <div className="py-1 max-h-72 overflow-y-auto">
          {PERSONAS.map((p) => {
            const c = PERSONA_CONFIG[p];
            const active = p === persona;
            return (
              <button
                key={p}
                onClick={() => handlePick(p)}
                className={cn(
                  'w-full text-left px-3 py-2 hover:bg-muted transition-colors flex items-start gap-2',
                  active && 'bg-muted/60',
                )}
              >
                <Check className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', active ? 'opacity-100' : 'opacity-0')} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground">{c.label}</div>
                  <div className="text-[11px] text-muted-foreground line-clamp-2">{c.description}</div>
                </div>
              </button>
            );
          })}
        </div>
        {override && (
          <div className="p-2 border-t border-border">
            <Button variant="ghost" size="sm" onClick={handleClear} className="w-full text-xs">
              <X className="w-3 h-3 mr-1.5" />
              Limpar override (voltar pro automático)
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
