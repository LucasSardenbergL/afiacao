// Central da Ferramenta e Serviços — home-hub do cliente que reúne o ciclo da
// afiação (economia/ROI → ferramentas → recorrência → pedidos) num só lugar.
// Só ORQUESTRA dado já existente: cada bloco reusa um hook de outra tela e leva
// ao detalhe. Sem escrita, sem money-path (economia é estimativa já rotulada).
import { useNavigate } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { ChevronRight, PiggyBank, Wrench, CalendarClock, Package } from 'lucide-react';
import { differenceInDays, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { cn } from '@/lib/utils';
import { useSavingsSummary } from '@/queries/useSavings';
import { useUserToolsSummary } from '@/queries/useUserTools';
import { useActiveRecurringSchedules } from '@/queries/useRecurringSchedules';
import { useCustomerPendingOrders } from '@/queries/useOrders';

/** R$ com separador de milhar (mesmo formato do painel de economia). */
function formatBRL(v: number): string {
  return v.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function HubCard({
  icon: Icon,
  title,
  description,
  onClick,
  alert = false,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  onClick: () => void;
  alert?: boolean;
}) {
  return (
    <button onClick={onClick} className="w-full text-left" aria-label={title}>
      <Card className="hover:border-primary/30 hover:shadow-medium transition-all">
        <CardContent className="p-4 flex items-center gap-4">
          <div
            className={cn(
              'w-11 h-11 rounded-xl flex items-center justify-center shrink-0',
              alert ? 'bg-status-warning-bg' : 'bg-muted',
            )}
          >
            <Icon className={cn('w-5 h-5', alert ? 'text-status-warning' : 'text-muted-foreground')} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-foreground">{title}</p>
            <p className="text-sm text-muted-foreground truncate">{description}</p>
          </div>
          <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0" />
        </CardContent>
      </Card>
    </button>
  );
}

const CentralFerramenta = () => {
  const navigate = useNavigate();
  const { user } = useAuth();

  const { summary, isPending: savingsPending } = useSavingsSummary(user?.id);
  const { data: tools = [], isLoading: toolsLoading } = useUserToolsSummary(user?.id);
  const { data: schedules = [] } = useActiveRecurringSchedules(user?.id);
  const { data: pendingOrders = [] } = useCustomerPendingOrders(user?.id);

  const loading = savingsPending || toolsLoading;

  // Ferramentas que precisam de atenção: vencidas OU a ≤7 dias do vencimento
  // (mesma régua de urgência do CustomerDashboard).
  const toolsNeedingAttention = tools.filter((t) => {
    if (!t.next_sharpening_due) return false;
    return differenceInDays(new Date(t.next_sharpening_due), new Date()) <= 7;
  }).length;

  const nextSchedule = schedules[0]; // ativos ordenados por next_order_date asc
  const ordersAwaitingApproval = pendingOrders.filter(
    (o) => o.status === 'orcamento_enviado',
  ).length;

  const savingsDisplay = summary.totalSavings > 0 ? summary.totalSavings : 0;

  if (loading) {
    return (
      <div className="max-w-lg mx-auto">
        <PageSkeleton variant="list" />
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto space-y-4 pb-8">
      <header className="space-y-1">
        <h1 className="font-display font-bold text-2xl text-foreground">Central da Ferramenta</h1>
        <p className="text-sm text-muted-foreground">
          Suas ferramentas, afiações, agendamentos e economia num só lugar.
        </p>
      </header>

      {/* Bloco herói: Economia / ROI — o diferencial da afiação */}
      <button onClick={() => navigate('/savings')} className="w-full text-left" aria-label="Ver economia detalhada">
        <Card className="bg-gradient-to-br from-emerald-500 to-emerald-700 text-white border-0 hover:brightness-105 transition-all">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <PiggyBank className="w-5 h-5 opacity-90" />
                <span className="text-sm font-medium opacity-90">Economia com afiação</span>
              </div>
              <ChevronRight className="w-5 h-5 opacity-70" />
            </div>
            {summary.totalTools > 0 ? (
              <>
                <p className="text-3xl font-bold mt-2">R$ {formatBRL(savingsDisplay)}</p>
                <p className="text-sm opacity-90 mt-1">
                  {summary.savingsPercent > 0 ? `~${summary.savingsPercent}% vs. comprar novas · ` : ''}
                  {summary.totalTools} afiaç{summary.totalTools === 1 ? 'ão' : 'ões'}
                </p>
              </>
            ) : (
              <p className="text-sm opacity-90 mt-2">
                Comece a economizar afiando em vez de comprar ferramentas novas.
              </p>
            )}
          </CardContent>
        </Card>
      </button>

      <HubCard
        icon={Wrench}
        title="Ferramentas"
        onClick={() => navigate('/tools')}
        alert={toolsNeedingAttention > 0}
        description={
          tools.length === 0
            ? 'Cadastre sua primeira ferramenta para acompanhar a afiação.'
            : `${tools.length} ferramenta${tools.length === 1 ? '' : 's'}` +
              (toolsNeedingAttention > 0
                ? ` · ${toolsNeedingAttention} precisa${toolsNeedingAttention === 1 ? '' : 'm'} de atenção`
                : ' · todas em dia')
        }
      />

      <HubCard
        icon={CalendarClock}
        title="Agendamentos automáticos"
        onClick={() => navigate('/recurring-schedules')}
        description={
          nextSchedule
            ? `Próximo pedido automático em ${format(new Date(nextSchedule.next_order_date), "dd 'de' MMM", { locale: ptBR })}`
            : 'Automatize suas afiações com pedidos recorrentes.'
        }
      />

      <HubCard
        icon={Package}
        title="Pedidos"
        onClick={() => navigate('/orders')}
        alert={ordersAwaitingApproval > 0}
        description={
          pendingOrders.length === 0
            ? 'Nenhum pedido em andamento.'
            : `${pendingOrders.length} em andamento` +
              (ordersAwaitingApproval > 0
                ? ` · ${ordersAwaitingApproval} aguardando sua aprovação`
                : '')
        }
      />
    </div>
  );
};

export default CentralFerramenta;
