import { FilaDoDia } from '@/components/fila/FilaDoDia';
import { PositivacaoHero } from '@/components/farmer/PositivacaoHero';
import { useMyPositivacao } from '@/hooks/useMyPositivacao';
import { useSinalPositivacao } from '@/hooks/useSinalPositivacao';
import { estadoDeLeitura, naoConsegui } from '@/lib/leitura/estado-de-leitura';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { PedidosSemNotaBanner } from './PedidosSemNotaBanner';
import { AtivarNotificacoesCard } from '@/components/push/AtivarNotificacoesCard';

/**
 * Meu Dia da farmer — placar do mês (positivação) + a FILA única de quem ligar.
 *
 * O bloco de positivação (PositivacaoHero) é o NORTE da farmer: positivação MTD,
 * receita MTD, novos na carteira, cobertura — KPIs comerciais que também serão base do OTE
 * (ver docs/superpowers/specs/2026-06-06-kpis-farmer-meu-dia-design.md). A fila é a ação do dia:
 * a lista de recompra gerada no servidor, e a ficha da ligação abre ao tocar no cliente
 * (programa "Venda por cliente", docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md).
 *
 * Saíram (Fase 5): o "modo antigo" (tarefas, ligações da rota, agenda WebRTC), o SLA do WhatsApp,
 * as KPIs de chamadas e o nudge de ligações sem vínculo — todos repetiam a fila ou apontavam para
 * módulos congelados pelo M-41 (telefonia/WhatsApp/rota/tarefas, até 2027-01-10). As rotas não
 * foram apagadas; só os pontos de entrada saíram do Meu Dia.
 */
export function FarmerDashboardV2() {
  const qPositivacao = useMyPositivacao();
  const { data: positivacao } = qPositivacao;
  const estadoPositivacao = estadoDeLeitura(qPositivacao);
  useSinalPositivacao();

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Meu dia</h1>
        <p className="text-xs text-muted-foreground">
          Seu placar do mês e quem ligar hoje: trabalhe a lista de cima pra baixo e registre como foi cada ligação.
        </p>
      </div>

      {/* Opt-in de Web Push — some quando ativo/negado/sem suporte/dispensado */}
      <AtivarNotificacoesCard />

      {/* ~27% da venda do último ano é pedido sem nota no Omie e conta como venda → aviso MEDIDO */}
      <PedidosSemNotaBanner />

      {/* Placar do mês (KPIs da carteira) — o norte da farmer.
          O aviso vem ANTES e FORA do `&&`: sem ele o placar sumia calado no erro/offline, e numa
          tela que é o norte da vendedora a ausência AFIRMA que está tudo bem (#1886). */}
      {naoConsegui(estadoPositivacao) && (
        <AvisoLeituraFalhou oque="a positivação da sua carteira" estado={estadoPositivacao} />
      )}
      {positivacao && <PositivacaoHero kpis={positivacao} isHunter={false} />}

      {/* A fila É o dia. */}
      <FilaDoDia />
    </div>
  );
}
