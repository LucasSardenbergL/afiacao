// Helpers de apresentação das paradas de rota.
// Extraído de src/pages/AdminRoutePlanner.tsx (god-component split).
import { Truck, ShoppingBag, Layers, Users, Calendar, Target } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { StopType, ManualCustomer, RouteStop } from './types';

export const formatDuration = (min: number) => {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
};

export const getStopIcon = (type: StopType) => {
  switch (type) {
    case 'pickup_tools': return <Truck className="w-3.5 h-3.5" />;
    case 'deliver_tools': return <Truck className="w-3.5 h-3.5" />;
    case 'sales_visit': return <ShoppingBag className="w-3.5 h-3.5" />;
    case 'hybrid_visit': return <Layers className="w-3.5 h-3.5" />;
    case 'manual_visit': return <Users className="w-3.5 h-3.5" />;
    case 'scheduled_visit': return <Calendar className="w-3.5 h-3.5" />;
    case 'prospect_visit': return <Target className="w-3.5 h-3.5" />;
  }
};

export const getVisitBadge = (customer: ManualCustomer) => {
  if (customer.daysSinceLastVisit === null) {
    return <Badge variant="danger" className="text-xs">Nunca visitado</Badge>;
  }
  if (customer.daysSinceLastVisit > 30) {
    return <Badge variant="warning" className="text-xs">Última visita há {customer.daysSinceLastVisit} dias</Badge>;
  }
  return null;
};

export const getOrderBadge = (customer: ManualCustomer) => {
  if (customer.daysSinceLastOrder === null) {
    return null;
  }
  if (customer.daysSinceLastOrder > 90) {
    return <Badge variant="danger" className="text-xs">Sem compra há {customer.daysSinceLastOrder} dias</Badge>;
  }
  if (customer.daysSinceLastOrder > 30) {
    return <Badge variant="warning" className="text-xs">Comprou há {customer.daysSinceLastOrder} dias</Badge>;
  }
  if (customer.daysSinceLastOrder <= 30) {
    return <Badge variant="success" className="text-xs">Comprou recentemente</Badge>;
  }
  return null;
};

export const getCTALabel = (stop: RouteStop) => {
  if (stop.orderId) return 'Ver pedido';
  if (stop.visitReason.includes('afiação vencida')) return 'Criar pedido de afiação';
  return 'Criar pedido';
};
