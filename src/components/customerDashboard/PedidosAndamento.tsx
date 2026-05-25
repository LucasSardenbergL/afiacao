// Seção "Pedidos em Andamento" do CustomerDashboard.
// Extraída verbatim de src/components/CustomerDashboard.tsx (god-component split).
import { useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { OrderRow } from './OrderRow';
import type { Order } from './types';

interface PedidosAndamentoProps {
  ordersNeedingAction: Order[];
  otherActiveOrders: Order[];
  navigate: ReturnType<typeof useNavigate>;
}

export function PedidosAndamento({ ordersNeedingAction, otherActiveOrders, navigate }: PedidosAndamentoProps) {
  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display font-bold text-lg text-foreground">Pedidos em Andamento</h2>
        <button onClick={() => navigate('/orders')} className="text-sm font-medium text-primary flex items-center gap-1 hover:gap-2 transition-all">
          Ver todos <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <div className="space-y-2.5">
        {/* Orders needing action first */}
        {ordersNeedingAction.map((order, i) => (
          <OrderRow key={order.id} order={order} index={i} navigate={navigate} needsAction />
        ))}
        {otherActiveOrders.slice(0, 3).map((order, i) => (
          <OrderRow key={order.id} order={order} index={ordersNeedingAction.length + i} navigate={navigate} />
        ))}
      </div>
    </>
  );
}
