// Lógica de ação prioritária do CustomerDashboard.
// Extraída verbatim de src/components/CustomerDashboard.tsx (god-component split).
import { AlertTriangle, Wrench, MapPin, CheckCircle2, FileText } from 'lucide-react';
import type { Order, UserTool, PriorityAction } from './types';

export function computePriority(
  pendingOrders: Order[],
  toolsOverdue: UserTool[],
  userTools: UserTool[],
  hasAddresses: boolean,
): PriorityAction {
  // 1. Pending quote
  const quoteOrder = pendingOrders.find(o => o.status === 'orcamento_enviado');
  if (quoteOrder) {
    return {
      type: 'quote', variant: 'warning', icon: FileText,
      title: 'Orçamento pendente de aprovação',
      description: 'Revise e aprove para que a afiação seja iniciada.',
      buttonLabel: 'Ver orçamento', path: `/orders/${quoteOrder.id}`,
      orderId: quoteOrder.id,
    };
  }

  // 2. Tools overdue
  if (toolsOverdue.length > 0) {
    return {
      type: 'tools_overdue', variant: 'destructive', icon: AlertTriangle,
      title: `${toolsOverdue.length} ferramenta(s) com afiação vencida`,
      description: 'Ferramentas fora do prazo podem perder o fio e danificar peças.',
      buttonLabel: 'Agendar afiação', path: '/new-order',
    };
  }

  // 3. No tools registered
  if (userTools.length === 0) {
    return {
      type: 'no_tools', variant: 'default', icon: Wrench,
      title: 'Cadastre suas ferramentas',
      description: 'Facilite seus pedidos e receba alertas de manutenção.',
      buttonLabel: 'Cadastrar', path: '/tools',
    };
  }

  // 4. No address
  if (!hasAddresses) {
    return {
      type: 'no_address', variant: 'default', icon: MapPin,
      title: 'Cadastre um endereço para agilizar coletas',
      description: 'Com um endereço salvo, seus pedidos ficam mais rápidos.',
      buttonLabel: 'Adicionar', path: '/addresses',
    };
  }

  // 5. All good
  return {
    type: 'all_good', variant: 'success', icon: CheckCircle2,
    title: 'Tudo em dia!',
    description: 'Suas ferramentas estão bem cuidadas.',
  };
}
