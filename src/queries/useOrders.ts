import { useQuery } from '@tanstack/react-query';
import { subMonths } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';

export interface Order {
  id: string;
  status: string;
  service_type: string;
  items: unknown[];
  total: number;
  created_at: string;
  delivery_option: string;
  user_id?: string;
  profiles?: { name: string };
}

/** Customer's pending (non-entregue) orders */
export function useCustomerPendingOrders(userId: string | undefined) {
  return useQuery({
    queryKey: ['orders', 'customer-pending', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('id, status, created_at, service_type')
        .eq('user_id', userId!)
        .neq('status', 'entregue')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as Order[];
    },
    enabled: !!userId,
  });
}

type DeliveredOrder = Pick<Order, 'id' | 'items' | 'total' | 'created_at' | 'status'>;

/** Pedidos ENTREGUES dos últimos 12 meses (base do painel de economia). */
export function useDeliveredOrders12m(userId: string | undefined) {
  return useQuery({
    queryKey: ['orders', 'delivered-12m', userId],
    queryFn: async () => {
      const twelveMonthsAgo = subMonths(new Date(), 12);
      const { data, error } = await supabase
        .from('orders')
        .select('id, items, total, created_at, status')
        .eq('user_id', userId!)
        .eq('status', 'entregue')
        .gte('created_at', twelveMonthsAgo.toISOString())
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as DeliveredOrder[];
    },
    enabled: !!userId,
  });
}
