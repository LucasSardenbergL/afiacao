import { Card, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Eye } from 'lucide-react';
import { useImpersonationTargets } from '@/hooks/useImpersonationTargets';
import { useImpersonation } from '@/contexts/ImpersonationContext';

export function ViewAsPicker() {
  const { data: targets = [], isLoading } = useImpersonationTargets();
  const { isImpersonating, target, startImpersonation, stopImpersonation } = useImpersonation();

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Eye className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-base font-medium">Ver como</h2>
        </div>
        <p className="text-2xs text-muted-foreground">
          Entre na visão (layout + dados reais, somente leitura) de um vendedor pra conferir.
        </p>
      </CardHeader>
      <div className="p-3 flex flex-wrap gap-2">
        {isLoading && <span className="text-2xs text-muted-foreground">Carregando…</span>}
        {targets.map((t) => {
          const active = isImpersonating && target?.id === t.id;
          return (
            <Button
              key={t.id}
              size="sm"
              variant={active ? 'default' : 'outline'}
              onClick={() => (active ? stopImpersonation() : startImpersonation(t, 'QA via MasterDashboard'))}
            >
              {t.nome}{t.grupo ? ` · ${t.grupo}` : ''}{active ? ' ✓' : ''}
            </Button>
          );
        })}
      </div>
    </Card>
  );
}
