import { ChevronRight, Package } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Order, TOOL_CATEGORIES, ORDER_STATUS } from '@/types';
import { StatusBadgeSimple } from './StatusBadge';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface OrderCardProps {
  order: Order;
}

export function OrderCard({ order }: OrderCardProps) {
  const navigate = useNavigate();

  const itemsSummary = order.items.length === 1
    ? `${order.items[0].quantity}x ${TOOL_CATEGORIES[order.items[0].category]}`
    : `${order.items.reduce((acc, item) => acc + item.quantity, 0)} itens`;

  return (
    <button
      onClick={() => navigate(`/orders/${order.id}`)}
      className="w-full bg-card rounded-xl p-4 shadow-soft border border-border hover:shadow-medium transition-smooth text-left"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
            <Package className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <h3 className="font-semibold text-foreground">{order.orderNumber}</h3>
            <p className="text-xs text-muted-foreground">
              {format(order.createdAt, "dd 'de' MMM", { locale: ptBR })}
            </p>
          </div>
        </div>
        <ChevronRight className="w-5 h-5 text-muted-foreground" />
      </div>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground mb-1">{itemsSummary}</p>
          <StatusBadgeSimple status={order.status} size="sm" />
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-foreground">
            R$ {order.total.toFixed(2).replace('.', ',')}
          </p>
          {order.estimatedDelivery && order.status !== 'entregue' && (
            <p className="text-xs text-muted-foreground">
              Previsão: {format(order.estimatedDelivery, 'dd/MM')}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}
