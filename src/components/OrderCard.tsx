import { ChevronRight, Package } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { TOOL_CATEGORIES, ORDER_STATUS, ToolCategory } from '@/types';
import { StatusBadgeSimple } from './StatusBadge';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

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

export function OrderCard({ order }: OrderCardProps) {
  const navigate = useNavigate();

  // Parse items if it's a JSON string
  const items: OrderItem[] = Array.isArray(order.items) 
    ? order.items 
    : typeof order.items === 'string' 
      ? JSON.parse(order.items) 
      : [];

  const itemsSummary = items.length === 1
    ? `${items[0].quantity}x ${TOOL_CATEGORIES[items[0].category as ToolCategory] || items[0].category}`
    : `${items.reduce((acc, item) => acc + (item.quantity || 1), 0)} itens`;

  // Generate order number from id (first 8 chars uppercase)
  const orderNumber = `#${order.id.slice(0, 8).toUpperCase()}`;

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
            <h3 className="font-semibold text-foreground">{orderNumber}</h3>
            <p className="text-xs text-muted-foreground">
              {format(new Date(order.created_at), "dd 'de' MMM", { locale: ptBR })}
            </p>
          </div>
        </div>
        <ChevronRight className="w-5 h-5 text-muted-foreground" />
      </div>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground mb-1">{itemsSummary}</p>
          <StatusBadgeSimple status={order.status as any} size="sm" />
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-foreground">
            R$ {Number(order.total).toFixed(2).replace('.', ',')}
          </p>
        </div>
      </div>
    </button>
  );
}
