import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Calendar, Phone, ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { track } from '@/lib/analytics';
import { KpisToday } from './KpisToday';
import { AgendaTodayList } from './AgendaTodayList';
import { MinhasTarefasCard } from '@/components/tarefas/MinhasTarefasCard';
import { VisitasHojeCard } from './VisitasHojeCard';
import { FilaDoDia } from '@/components/fila/FilaDoDia';

/**
 * Dashboard Farmer V2 — a FILA é o dia (G1). Os cards antigos (tarefas, ligações
 * da rota, agenda) repetem o que a fila já mostra → recolhidos num "modo antigo"
 * (fallback a 1 clique). Mantém fora do colapso só o que a fila NÃO cobre:
 * KPIs (informativo) e visitas. Decisão founder + Codex (piloto).
 */
export function FarmerDashboardV2() {
  const [modoAntigoAberto, setModoAntigoAberto] = useState(false);
  const onToggleModoAntigo = (open: boolean) => {
    setModoAntigoAberto(open);
    // sinal do piloto: se ela abre o modo antigo todo dia, a fila não está servindo.
    if (open) track('fila.modo_antigo_expandido', {});
  };

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Meu dia</h1>
        <p className="text-xs text-muted-foreground">
          Sua fila priorizada: comece de cima. Tarefas, ligações da rota e oportunidades, do mais urgente ao menos.
        </p>
      </div>

      {/* A fila É o dia. */}
      <FilaDoDia />

      <KpisToday />

      <VisitasHojeCard />

      <Collapsible open={modoAntigoAberto} onOpenChange={onToggleModoAntigo}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="text-2xs text-muted-foreground gap-1.5">
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${modoAntigoAberto ? 'rotate-180' : ''}`} />
            Ver detalhes do dia (modo antigo)
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-2">
          <MinhasTarefasCard />

          {/* Ligações da rota — o que as vendedoras (farmer só-ligação) de fato fazem; lista priorizada D-1 em /rota/ligacoes */}
          <Card className="p-4 border-status-info/40">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Phone className="w-4 h-4 text-status-info" />
                  <h2 className="text-sm font-semibold">Ligações da rota</h2>
                </div>
                <p className="text-2xs text-muted-foreground mt-1">
                  Sua lista priorizada de quem ligar — clientes nas cidades da rota de amanhã.
                </p>
              </div>
              <Button asChild size="sm">
                <Link to="/rota/ligacoes">Abrir lista</Link>
              </Button>
            </div>
          </Card>

          <Card className="p-3 space-y-1">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-status-warning" />
              <h2 className="text-sm font-semibold">Agenda de hoje (top 10)</h2>
            </div>
            <p className="text-2xs text-muted-foreground">
              Priorizada por priority_score da sua carteira. Clique no nome pra ficha; clique Ligar pra disparar chamada WebRTC.
            </p>
          </Card>

          <AgendaTodayList />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
