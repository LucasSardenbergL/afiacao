import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface CustomerLastOrder {
  date: string | null;
  total: number | null;
}

/**
 * Última COMPRA (venda de produto) do cliente — de `sales_orders` por customer_user_id.
 * NÃO é a tabela `orders` (afiação/serviço). `date` = order_date_kpi (data do pedido pra KPI)
 * com fallback created_at. RLS de sales_orders filtra carteira/gestor — degradação honesta.
 * Read-only. Retorna null quando não há compra visível.
 */
export function useCustomerLastSalesOrder(customerId: string | null) {
  return useQuery({
    queryKey: ['customer-last-sales-order', customerId],
    enabled: !!customerId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<CustomerLastOrder | null> => {
      if (!customerId) return null;
      const { data, error } = await supabase
        .from('sales_orders')
        .select('order_date_kpi, created_at, total')
        .eq('customer_user_id', customerId)
        .order('order_date_kpi', { ascending: false, nullsFirst: false })
        .limit(1);
      if (error) throw new Error(error.message);
      const row = data?.[0];
      if (!row) return null;
      return { date: row.order_date_kpi ?? row.created_at, total: row.total ?? null };
    },
  });
}
