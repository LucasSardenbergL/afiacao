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
import { SlaCardMeuDia } from '@/components/whatsapp/SlaCardMeuDia';
import { FilaDoDia } from '@/components/fila/FilaDoDia';
import { PositivacaoHero } from '@/components/farmer/PositivacaoHero';
import { useMyPositivacao } from '@/hooks/useMyPositivacao';
import { AtivarNotificacoesCard } from '@/components/push/AtivarNotificacoesCard';
import { ChamadasPendentesNudge } from '@/components/farmer/ChamadasPendentesNudge';

/**
 * Dashboard Farmer V2 — placar do mês (positivação) + a FILA é o dia (G1).
 *
 * O bloco de positivação (PositivacaoHero) é o NORTE da farmer: positivação MTD,
 * receita MTD, win-back, cobertura — KPIs comerciais que também serão base do OTE
 * (ver docs/superpowers/specs/2026-06-06-kpis-farmer-meu-dia-design.md). A fila é
 * a ação do dia. Os cards antigos (tarefas, ligações da rota, agenda) repetem a
 * fila → recolhidos num "modo antigo" (1 clique). VISITAS foram removidas: não são
 * o trabalho da farmer (isso é o CloserDashboard). isHunter=false: hunter tem o
 * próprio dashboard (HunterDashboard), não chega aqui pelo CommercialDashboard.
 */
export function FarmerDashboardV2() {
  const [modoAntigoAberto, setModoAntigoAberto] = useState(false);
  const { data: positivacao } = useMyPositivacao();
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
          Seu placar do mês e a fila priorizada: olhe a positivação, depois trabalhe a fila de cima pra baixo.
        </p>
      </div>

      {/* Opt-in de Web Push — some quando ativo/negado/sem suporte/dispensado */}
      <AtivarNotificacoesCard />

      {/* Placar do mês (KPIs da carteira) — o norte da farmer */}
      {positivacao && <PositivacaoHero kpis={positivacao} isHunter={false} />}

      {/* A fila É o dia. */}
      <FilaDoDia />

      {/* Atividade de hoje */}
      <KpisToday />

      {/* nudge saliente: clientes sem resposta no WhatsApp — fica FORA do "modo antigo" recolhido */}
      <SlaCardMeuDia />

      {/* nudge condicional: ligações registradas sem cliente vinculado (era item do menu Vendas) */}
      <ChamadasPendentesNudge />

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
