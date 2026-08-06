// Lógica de ação prioritária do CustomerDashboard.
// Extraída verbatim de src/components/CustomerDashboard.tsx (god-component split).
import { AlertTriangle, Wrench, MapPin, CalendarPlus, CheckCircle2, FileText } from 'lucide-react';
import { ehNuncaAfiada } from '@/lib/afiacao/recomendacoes';
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

  // 5. Cadastrou mas nunca afiou — empurra a 1ª afiação (não é "tudo em dia": sem
  //    histórico não há o que estar "bem cuidado"). Mesmo predicado do helper de
  //    recomendações (fonte única) — ausente ≠ zero.
  const nuncaAfiadas = userTools.filter(ehNuncaAfiada);
  if (nuncaAfiadas.length > 0) {
    return {
      type: 'nunca_afiada', variant: 'default', icon: CalendarPlus,
      title: 'Agende a primeira afiação',
      description: `${nuncaAfiadas.length} ferramenta${nuncaAfiadas.length === 1 ? '' : 's'} cadastrada${nuncaAfiadas.length === 1 ? '' : 's'} ainda sem nenhuma afiação. Agende a primeira para começar.`,
      buttonLabel: 'Agendar afiação', path: '/new-order',
    };
  }

  // 6. All good
  return {
    type: 'all_good', variant: 'success', icon: CheckCircle2,
    title: 'Tudo em dia!',
    description: 'Suas ferramentas estão bem cuidadas.',
  };
}
