// Card de uma visita realizada hoje (planejador de rotas).
// Extraído de src/pages/AdminRoutePlanner.tsx (god-component split).
// Presentational: deriva isActive/duração/horário do próprio registro.
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export interface TodayVisit {
  id: string;
  customerName: string;
  check_in_at: string | null;
  check_out_at: string | null;
  result: string | null;
}

export function TodayVisitCard({ visit }: { visit: TodayVisit }) {
  const isActive = !visit.check_out_at;
  const duration =
    visit.check_out_at && visit.check_in_at
      ? Math.floor(
          (new Date(visit.check_out_at).getTime() - new Date(visit.check_in_at).getTime()) / 60000,
        )
      : null;
  const checkInTime = visit.check_in_at
    ? new Date(visit.check_in_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : '—';
  return (
    <Card className={isActive ? 'border-status-success/60' : ''}>
      <CardContent className="py-3 px-4">
        <div className="flex items-center gap-3">
          <div
            className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${isActive ? 'bg-status-success animate-pulse' : 'bg-muted-foreground'}`}
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{visit.customerName}</p>
            <p className="text-xs text-muted-foreground">
              Check-in: {checkInTime}
              {duration !== null && ` · ${duration}min`}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {isActive ? (
              <Badge variant="success" className="text-xs">Em visita</Badge>
            ) : visit.result ? (
              <Badge variant={visit.result === 'pedido_fechado' ? 'success' : 'outline'} className="text-xs">
                {visit.result === 'pedido_fechado' ? 'Pedido fechado'
                  : visit.result === 'interesse' ? 'Interesse'
                  : visit.result === 'sem_interesse' ? 'Sem interesse'
                  : visit.result === 'ausente' ? 'Ausente'
                  : visit.result === 'reagendar' ? 'Reagendar'
                  : visit.result}
              </Badge>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
