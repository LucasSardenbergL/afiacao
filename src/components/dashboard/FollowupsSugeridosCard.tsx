/**
 * Card "Follow-ups sugeridos" no dashboard Closer.
 * Lista as visitas do vendedor cujo estado atual pede retorno (mornas, sem agenda nem
 * contato posterior), com deep-link pro fluxo existente. Read-only / heurística — sugestão,
 * não "next best action inteligente". Self-hide quando vazio.
 * Spec: docs/superpowers/specs/2026-06-04-followups-sugeridos-design.md
 */
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CalendarClock, Flame, UserX, Loader2, ListTodo, type LucideIcon } from 'lucide-react';
import { useFollowupsVisita } from '@/hooks/useFollowupsVisita';
import { AgendarVisitaDialog } from '@/components/visitas/AgendarVisitaDialog';
import { recenciaLabel } from '@/lib/visitas/recencia';
import { hojeISO } from '@/lib/visitas/today';
import type { FollowupResult } from '@/lib/visitas/followups';

const LIMITE = 5;

const META: Record<FollowupResult, { label: string; icon: LucideIcon; box: string; text: string; acao: string }> = {
  reagendar: { label: 'Reagendar', icon: CalendarClock, box: 'bg-status-warning-bg', text: 'text-status-warning', acao: 'Agendar retorno' },
  interesse: { label: 'Interesse', icon: Flame, box: 'bg-status-info-bg', text: 'text-status-info', acao: 'Agendar retorno' },
  ausente: { label: 'Ausente', icon: UserX, box: 'bg-status-warning-bg', text: 'text-status-warning', acao: 'Tentar de novo' },
};

export function FollowupsSugeridosCard() {
  const { data, isLoading } = useFollowupsVisita();

  if (isLoading) {
    return (
      <Card className="p-6 flex justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </Card>
    );
  }

  const items = data?.items ?? [];
  if (items.length === 0) return null; // self-hide

  const hoje = hojeISO();
  const visiveis = items.slice(0, LIMITE);
  const restante = items.length - visiveis.length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-2">
          <ListTodo className="w-4 h-4 text-muted-foreground" />
          <div>
            <h2 className="text-base font-medium">Follow-ups sugeridos</h2>
            <p className="text-2xs text-muted-foreground">Visitas que pedem retorno</p>
          </div>
        </div>
        <Badge variant="outline" className="text-2xs">{items.length}</Badge>
      </CardHeader>

      <div className="divide-y divide-border">
        {visiveis.map((it) => {
          const meta = META[it.result];
          const Icon = meta.icon;
          const nome = data?.nomePorCliente.get(it.customerUserId) || 'Cliente';
          return (
            <div key={it.customerUserId} className="p-3 flex items-center gap-3 hover:bg-muted/30">
              <div className={`p-1.5 rounded ${meta.box} ${meta.text} shrink-0`}>
                <Icon className="w-4 h-4" />
              </div>

              <Link to={`/admin/customers/${it.customerUserId}/360`} className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{nome}</div>
                <div className="text-2xs text-muted-foreground flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={`${meta.text} text-2xs`}>{meta.label}</Badge>
                  <span>{recenciaLabel(it.lastVisitAt, hoje)}</span>
                </div>
                {it.notes && (
                  <div className="text-2xs text-muted-foreground/80 truncate mt-0.5 italic">&ldquo;{it.notes}&rdquo;</div>
                )}
              </Link>

              <AgendarVisitaDialog
                customerUserId={it.customerUserId}
                customerName={nome}
                trigger={
                  <Button size="sm" variant="outline" className="shrink-0">
                    <CalendarClock className="w-3.5 h-3.5 mr-1" />
                    {meta.acao}
                  </Button>
                }
              />
            </div>
          );
        })}
      </div>

      {restante > 0 && (
        <div className="px-3 pb-3 pt-1 text-2xs text-muted-foreground">+{restante} mais</div>
      )}
    </Card>
  );
}
