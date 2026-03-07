import { Check, Clock, AlertTriangle } from 'lucide-react';
import { ORDER_STATUS, OrderStatus } from '@/types';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { Badge } from './ui/badge';

interface StatusHistoryItem {
  status: string;
  timestamp: Date;
  note?: string;
  operator?: string;
}

interface OrderTimelineProps {
  statusHistory: StatusHistoryItem[];
  currentStatus: OrderStatus;
}

const allStatuses: OrderStatus[] = [
  'pedido_recebido',
  'aguardando_coleta',
  'em_triagem',
  'orcamento_enviado',
  'aprovado',
  'em_afiacao',
  'controle_qualidade',
  'pronto_entrega',
  'em_rota',
  'entregue',
];

const STEP_EXPLANATIONS: Record<string, string> = {
  pedido_recebido: 'Seu pedido foi registrado no sistema',
  aguardando_coleta: 'Nossa equipe vai buscar suas ferramentas',
  em_triagem: 'Estamos analisando suas ferramentas',
  orcamento_enviado: 'Verifique e aprove o valor do serviço',
  aprovado: 'Orçamento aprovado, entrando na fila de afiação',
  em_afiacao: 'Suas ferramentas estão sendo afiadas',
  controle_qualidade: 'Verificação final de qualidade',
  pronto_entrega: 'Pronto! Aguardando retirada ou entrega',
  em_rota: 'Motoboy a caminho do seu endereço',
  entregue: 'Pedido concluído com sucesso',
};

const CLIENT_ACTION_STATUSES = new Set(['orcamento_enviado']);

export function OrderTimeline({ statusHistory, currentStatus }: OrderTimelineProps) {
  const completedStatuses = statusHistory.map(h => h.status);
  const currentIndex = allStatuses.indexOf(currentStatus);

  return (
    <div className="relative">
      {allStatuses.map((status, index) => {
        const historyItem = statusHistory.find(h => h.status === status);
        const isCompleted = completedStatuses.includes(status);
        const isCurrent = status === currentStatus;
        const isPending = index > currentIndex;
        const isClientAction = CLIENT_ACTION_STATUSES.has(status) && isCurrent;

        return (
          <div key={status} className="flex gap-4 pb-6 last:pb-0">
            {/* Line and dot */}
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center border-2 transition-all',
                  isCompleted && !isCurrent && 'bg-primary border-primary',
                  isCurrent && !isClientAction && 'bg-primary border-primary animate-pulse-glow',
                  isClientAction && 'bg-status-warning border-status-warning animate-pulse-glow',
                  isPending && 'bg-muted border-border'
                )}
              >
                {isClientAction ? (
                  <AlertTriangle className="w-4 h-4 text-primary-foreground" />
                ) : isCompleted && !isCurrent ? (
                  <Check className="w-4 h-4 text-primary-foreground" />
                ) : isCurrent ? (
                  <div className="w-2 h-2 rounded-full bg-primary-foreground" />
                ) : (
                  <Clock className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
              {index < allStatuses.length - 1 && (
                <div
                  className={cn(
                    'w-0.5 flex-1 mt-2',
                    isCompleted ? 'bg-primary' : 'bg-border'
                  )}
                />
              )}
            </div>

            {/* Content */}
            <div className={cn('flex-1 pb-4', isPending && 'opacity-50')}>
              <div className="flex items-center gap-2">
                <h4
                  className={cn(
                    'font-semibold',
                    isClientAction ? 'text-status-warning' : isCurrent ? 'text-primary' : isCompleted ? 'text-foreground' : 'text-muted-foreground'
                  )}
                >
                  {ORDER_STATUS[status]?.label || status}
                </h4>
                {isClientAction && (
                  <Badge variant="outline" className="text-[10px] border-status-warning text-status-warning bg-status-warning-bg font-semibold px-1.5 py-0">
                    Sua ação
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-0.5">
                {STEP_EXPLANATIONS[status] || ORDER_STATUS[status]?.description || ''}
              </p>
              {historyItem && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {format(historyItem.timestamp, "dd/MM 'às' HH:mm", { locale: ptBR })}
                  {historyItem.note && (
                    <p className="mt-0.5 text-muted-foreground italic">"{historyItem.note}"</p>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
