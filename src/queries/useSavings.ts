import { useMemo } from 'react';
import { useDeliveredOrders12m } from './useOrders';
import { computeSavings, type SavingsSummary } from '@/lib/afiacao/savings';

/**
 * Resumo de economia da afiação (ROI). Consome `useDeliveredOrders12m` e aplica
 * a função pura `computeSavings` — a MESMA usada pelo SavingsDashboard, para o
 * número não divergir entre a Central e o painel de economia.
 */
export function useSavingsSummary(userId: string | undefined): {
  summary: SavingsSummary;
  isPending: boolean;
  isLoading: boolean;
  isError: boolean;
} {
  const { data: orders = [], isPending, isLoading, isError } = useDeliveredOrders12m(userId);
  const summary = useMemo(() => computeSavings(orders), [orders]);
  return { summary, isPending, isLoading, isError };
}
