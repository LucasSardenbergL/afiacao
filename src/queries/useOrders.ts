import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

interface Order {
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
