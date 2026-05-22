// Helpers de apresentação puros do planejador de rotas.
// Extraídos de src/pages/AdminRoutePlanner.tsx (god-component split).
// Todos são puros (dependem só dos args + window/lucide), sem estado do componente.
//
// NOTA: formatDuration tem um bug pré-existente conhecido (`min % h` deveria ser
// `min % 60`) — preservado verbatim aqui; correção rastreada em task separada.
import { Truck, ShoppingBag, Layers, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { StopType, RouteStop, ManualCustomer } from './types';

export const formatTimer = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export const formatDuration = (min: number) => {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % h;
  return m > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
};

export const openInWaze = (stop: RouteStop) => {
  if (stop.lat && stop.lng) {
    window.open(`https://waze.com/ul?ll=${stop.lat},${stop.lng}&navigate=yes`, '_blank');
  } else {
    const q = `${stop.address.street}, ${stop.address.number}, ${stop.address.city}, ${stop.address.state}`;
    window.open(`https://waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`, '_blank');
  }
};

export const openInGoogleMaps = (stop: RouteStop) => {
  if (stop.lat && stop.lng) {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}`, '_blank');
  } else {
    const q = `${stop.address.street}, ${stop.address.number}, ${stop.address.city}, ${stop.address.state}`;
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`, '_blank');
  }
};

export const getStopIcon = (type: StopType) => {
  switch (type) {
    case 'pickup_tools': return <Truck className="w-3.5 h-3.5" />;
    case 'deliver_tools': return <Truck className="w-3.5 h-3.5" />;
    case 'sales_visit': return <ShoppingBag className="w-3.5 h-3.5" />;
    case 'hybrid_visit': return <Layers className="w-3.5 h-3.5" />;
    case 'manual_visit': return <Users className="w-3.5 h-3.5" />;
  }
};

export const getCTALabel = (stop: RouteStop) => {
  if (stop.orderId) return 'Ver pedido';
  if (stop.visitReason.includes('afiação vencida')) return 'Criar pedido de afiação';
  return 'Criar pedido';
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
