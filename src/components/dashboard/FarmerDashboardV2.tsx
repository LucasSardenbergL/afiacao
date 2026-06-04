import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Calendar, Phone } from 'lucide-react';
import { Link } from 'react-router-dom';
import { KpisToday } from './KpisToday';
import { AgendaTodayList } from './AgendaTodayList';
import { MinhasTarefasCard } from '@/components/tarefas/MinhasTarefasCard';
import { VisitasHojeCard } from './VisitasHojeCard';

/**
 * Dashboard Farmer V2 — foco em expansão de carteira existente.
 * Mostra KPIs do dia + agenda priorizada com botão "Ligar agora".
 *
 * NÃO substitui FarmerDashboard.tsx legado (438 LoC com mais features); apenas
 * é a versão "Meu dia" simplificada que aparece como home pro vendedor com
 * commercial_role=farmer. Legado continua acessível via outras rotas.
 */
export function FarmerDashboardV2() {
  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Meu dia</h1>
        <p className="text-xs text-muted-foreground">
          Agenda priorizada da sua carteira. Foque em risco e expansão primeiro.
        </p>
      </div>

      <KpisToday />

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

      <VisitasHojeCard />

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
    </div>
  );
}
