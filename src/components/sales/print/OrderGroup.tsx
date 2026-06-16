// Grupo de pedidos por período (manhã/tarde) na Impressão de Pedidos.
// Extraído de src/pages/SalesPrintDashboard.tsx (god-component split).
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Sun, Sunset, Printer } from 'lucide-react';
import { horaExibicaoPedido } from '@/lib/pedido/dia-civil';
import type { CompanyFilter, EnrichedOrder } from './types';

export function OrderGroup({ company, period, orders, selectedOrders, onToggleOrder, onPrintSingle }: {
  company: CompanyFilter;
  period: 'manha' | 'tarde';
  orders: EnrichedOrder[];
  selectedOrders: Set<string>;
  onToggleOrder: (id: string) => void;
  onPrintSingle: (order: EnrichedOrder) => void;
}) {
  if (orders.length === 0) return null;
  const periodLabel = period === 'manha' ? 'Manhã' : 'Tarde';
  const PeriodIcon = period === 'manha' ? Sun : Sunset;

  return (
    <div key={`${company}-${period}`} className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <PeriodIcon className="h-4 w-4" />
        <span>{periodLabel}</span>
        <Badge variant="secondary" className="text-xs">{orders.length}</Badge>
      </div>
      <div className="space-y-1.5">
        {orders.map(order => (
          <div
            key={order.id}
            className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors cursor-pointer"
            onClick={() => onToggleOrder(order.id)}
          >
            <Checkbox
              checked={selectedOrders.has(order.id)}
              onCheckedChange={() => onToggleOrder(order.id)}
              onClick={e => e.stopPropagation()}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium">
                  {order.omie_numero_pedido ? `#${order.omie_numero_pedido.replace(/^0+/, '')}` : order.id.slice(0, 8).toUpperCase()}
                </span>
                <span className="text-xs text-muted-foreground">
                  {horaExibicaoPedido(order.created_at)}
                </span>
              </div>
              <div className="text-sm text-muted-foreground truncate">{order.customer_name}</div>
            </div>
            <div className="text-right">
              <div className="text-sm font-medium">
                {order.total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
              </div>
              <div className="text-xs text-muted-foreground">{(order.items || []).length} itens</div>
            </div>
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={e => { e.stopPropagation(); onPrintSingle(order); }}>
              <Printer className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
