import React from 'react';
import { ChevronRight, Package, AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { TOOL_CATEGORIES, ToolCategory } from '@/types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';

interface OrderItem {
  category: string;
  quantity: number;
}

interface OrderCardProps {
  order: {
    id: string;
    status: string;
    items: OrderItem[] | any;
    total: number;
    created_at: string;
  };
}

const STATUS_MAP: Record<string, { label: string; nextStep: string; className: string }> = {
  pedido_recebido: { label: 'Recebido', nextStep: 'Aguardando triagem', className: 'border-primary/30 bg-primary/5 text-primary' },
  aguardando_coleta: { label: 'Aguardando Coleta', nextStep: 'Coleta será agendada', className: 'border-status-warning/30 bg-status-warning-bg text-status-warning' },
  em_triagem: { label: 'Em Triagem', nextStep: 'Orçamento em breve', className: 'border-purple-400/30 bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-300' },
  orcamento_enviado: { label: 'Orçamento Enviado', nextStep: 'Aguardando sua aprovação', className: 'border-status-warning/40 bg-status-warning-bg text-status-warning' },
  aprovado: { label: 'Aprovado', nextStep: 'Entrando na fila de afiação', className: 'border-emerald-400/30 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300' },
  em_afiacao: { label: 'Em Afiação', nextStep: 'Ferramenta sendo afiada', className: 'border-primary/30 bg-primary/5 text-primary' },
  controle_qualidade: { label: 'Qualidade', nextStep: 'Verificação final', className: 'border-indigo-400/30 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300' },
  pronto_entrega: { label: 'Pronto p/ Entrega', nextStep: 'Entrega será agendada', className: 'border-emerald-400/30 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300' },
  em_rota: { label: 'Em Rota', nextStep: 'A caminho do seu endereço', className: 'border-indigo-400/30 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300' },
  entregue: { label: 'Entregue', nextStep: 'Pedido concluído', className: 'border-border bg-muted text-muted-foreground' },
};

export const OrderCard = React.memo(function OrderCard({ order }: OrderCardProps) {
  const navigate = useNavigate();

  const items: OrderItem[] = Array.isArray(order.items)
    ? order.items
    : typeof order.items === 'string'
      ? JSON.parse(order.items)
      : [];

  const totalItems = items.reduce((acc, item) => acc + (item.quantity || 1), 0);
  const itemsSummary = items.length === 1
    ? `${items[0].quantity}x ${TOOL_CATEGORIES[items[0].category as ToolCategory] || items[0].category}`
    : `${totalItems} ${totalItems === 1 ? 'item' : 'itens'}`;

  const orderNumber = `#${order.id.slice(0, 8).toUpperCase()}`;
  const isPending = order.status === 'orcamento_enviado';
  const config = STATUS_MAP[order.status] || { label: order.status, nextStep: '', className: 'border-border bg-muted text-muted-foreground' };

  return (
    <button
      onClick={() => navigate(`/orders/${order.id}`)}
      className={cn(
        'w-full bg-card rounded-xl p-4 shadow-soft border hover:shadow-medium transition-smooth text-left',
        isPending ? 'border-status-warning/50 ring-1 ring-status-warning/20' : 'border-border'
      )}
    >
      {/* Header row */}
      <div className="flex items-start justify-between mb-2.5">
        <div className="flex items-center gap-3">
          <div className={cn(
            'w-10 h-10 rounded-lg flex items-center justify-center',
            isPending ? 'bg-status-warning-bg' : 'bg-muted'
          )}>
            {isPending
              ? <AlertTriangle className="w-5 h-5 text-status-warning" />
              : <Package className="w-5 h-5 text-muted-foreground" />}
          </div>
          <div>
            <h3 className="font-semibold text-foreground">{orderNumber}</h3>
            <p className="text-xs text-muted-foreground">
              {format(new Date(order.created_at), "dd 'de' MMM, HH:mm", { locale: ptBR })}
            </p>
          </div>
        </div>
        <ChevronRight className="w-5 h-5 text-muted-foreground mt-1" />
      </div>

      {/* Info row */}
      <div className="flex items-center justify-between mb-2.5">
        <p className="text-sm text-muted-foreground">{itemsSummary}</p>
        <p className="text-base font-bold text-foreground">
          R$ {Number(order.total).toFixed(2).replace('.', ',')}
        </p>
      </div>

      {/* Status row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn('text-[11px] px-2.5 py-0.5 rounded-full font-semibold border whitespace-nowrap', config.className)}>
            {config.label}
          </span>
          {isPending && (
            <Badge variant="outline" className="text-[10px] border-status-warning text-status-warning bg-status-warning-bg font-semibold px-1.5 py-0">
              Ação necessária
            </Badge>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground truncate text-right">{config.nextStep}</p>
      </div>

      {/* CTA for pending */}
      {isPending && (
        <div className="mt-3 pt-3 border-t border-border">
          <Button
            size="sm"
            variant="outline"
            className="w-full text-xs border-status-warning/40 text-status-warning hover:bg-status-warning-bg"
            onClick={(e) => { e.stopPropagation(); navigate(`/orders/${order.id}`); }}
          >
            Aprovar orçamento
          </Button>
        </div>
      )}
    </button>
  );
});
