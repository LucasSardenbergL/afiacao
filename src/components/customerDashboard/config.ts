// Configs do CustomerDashboard: status, animações e ações rápidas.
// Extraídos verbatim de src/components/CustomerDashboard.tsx (god-component split).
import { PlusCircle, Wrench, Gamepad2, LifeBuoy, LayoutGrid } from 'lucide-react';

export const statusConfig: Record<string, { label: string; statusClass: string }> = {
  'pedido_recebido': { label: 'Recebido', statusClass: 'status-progress' },
  'aguardando_coleta': { label: 'Aguardando Coleta', statusClass: 'status-pending' },
  'em_triagem': { label: 'Em Triagem', statusClass: 'status-purple' },
  'orcamento_enviado': { label: 'Orçamento', statusClass: 'status-pending' },
  'aprovado': { label: 'Aprovado', statusClass: 'status-success' },
  'em_afiacao': { label: 'Em Afiação', statusClass: 'status-progress' },
  'controle_qualidade': { label: 'Qualidade', statusClass: 'status-indigo' },
  'pronto_entrega': { label: 'Pronto!', statusClass: 'status-success' },
  'em_rota': { label: 'Em Rota', statusClass: 'status-indigo' },
  'entregue': { label: 'Entregue', statusClass: 'bg-muted text-muted-foreground' },
};

export const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};
export const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.25, 0.1, 0.25, 1] as const } },
};

export const QUICK_ACTIONS = [
  { icon: LayoutGrid, label: 'Central', path: '/central' },
  { icon: PlusCircle, label: 'Novo Pedido', path: '/new-order' },
  { icon: Wrench, label: 'Ferramentas', path: '/tools' },
  { icon: Gamepad2, label: 'Gamificação', path: '/gamification' },
  { icon: LifeBuoy, label: 'Suporte', path: '/support' },
];
