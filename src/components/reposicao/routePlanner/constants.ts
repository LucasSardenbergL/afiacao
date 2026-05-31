// Constantes de config das paradas de rota (durações, prioridade, tipo).
// Extraídas de src/pages/AdminRoutePlanner.tsx (god-component split).
import { ArrowUp, ArrowRight, ArrowDown } from 'lucide-react';
import type { StopType, RouteStop } from './types';

export const STOP_DURATION_MIN: Record<StopType, number> = {
  pickup_tools: 10,
  deliver_tools: 8,
  sales_visit: 20,
  hybrid_visit: 30,
  manual_visit: 15,
  scheduled_visit: 20,
};

export const PRIORITY_CONFIG: Record<
  RouteStop['priorityLabel'],
  { label: string; bgClass: string; icon: typeof ArrowUp }
> = {
  alta: { label: 'Alta', bgClass: 'bg-status-error-bg text-status-error', icon: ArrowUp },
  media: { label: 'Média', bgClass: 'bg-status-warning-bg text-status-warning', icon: ArrowRight },
  baixa: { label: 'Baixa', bgClass: 'bg-muted text-muted-foreground', icon: ArrowDown },
};

export const STOP_CONFIG: Record<
  StopType,
  { label: string; color: string; bgClass: string; textClass: string; markerColor: string }
> = {
  pickup_tools: { label: 'Coleta', color: 'hsl(210, 80%, 50%)', bgClass: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200', textClass: 'text-blue-600', markerColor: '#3b82f6' },
  deliver_tools: { label: 'Entrega', color: 'hsl(142, 70%, 40%)', bgClass: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200', textClass: 'text-green-600', markerColor: '#22c55e' },
  sales_visit: { label: 'Comercial', color: 'hsl(30, 90%, 50%)', bgClass: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200', textClass: 'text-orange-600', markerColor: '#f97316' },
  hybrid_visit: { label: 'Híbrido', color: 'hsl(270, 70%, 55%)', bgClass: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200', textClass: 'text-purple-600', markerColor: '#a855f7' },
  manual_visit: { label: 'Manual', color: 'hsl(180, 70%, 45%)', bgClass: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200', textClass: 'text-cyan-600', markerColor: '#06b6d4' },
  scheduled_visit: { label: 'Agendada', color: 'hsl(45, 100%, 50%)', bgClass: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200', textClass: 'text-yellow-600', markerColor: '#eab308' },
};
