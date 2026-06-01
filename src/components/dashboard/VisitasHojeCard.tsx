import { Link } from 'react-router-dom';
import { CalendarCheck } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { track } from '@/lib/analytics';
import { useVisitasHoje } from '@/hooks/useVisitasHoje';

/**
 * Card "Visitas de hoje" — compromissos FIRMES (visitas_agendadas) que o vendedor
 * agendou para hoje. Distinto do AgendaTodayList (sugestões de ligação priorizadas).
 * Self-hide quando não há visita hoje.
 */
export function VisitasHojeCard() {
  const { resumo, isLoading } = useVisitasHoje();

  if (isLoading || resumo.total === 0) return null;

  const restantes = resumo.total - resumo.preview.length;

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarCheck className="w-4 h-4 text-status-info" />
          <div>
            <h2 className="text-sm font-semibold leading-none">Visitas de hoje</h2>
            <p className="text-xs text-muted-foreground">agendadas por você</p>
          </div>
        </div>
        <Badge variant="secondary">{resumo.total}</Badge>
      </div>

      <ul className="text-sm space-y-0.5">
        {resumo.preview.map((v) => (
          <li key={v.id} className="truncate">{v.nome}</li>
        ))}
      </ul>
      {restantes > 0 && (
        <p className="text-xs text-muted-foreground">+{restantes} restante{restantes > 1 ? 's' : ''}</p>
      )}

      <Button asChild size="sm" variant="outline" className="w-full">
        <Link to="/admin/route-planner" onClick={() => track('visitas_hoje.ver_rota')}>
          Ver rota
        </Link>
      </Button>
    </Card>
  );
}
