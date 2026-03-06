import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface Order {
  id: string;
  status: string;
  service_type: string;
  items: any[];
  total: number;
  created_at: string;
  delivery_option: string;
  user_id?: string;
  profiles?: { name: string };
}

/** Customer's own orders */
export function useCustomerOrders(userId: string | undefined) {
  return useQuery({
    queryKey: ['orders', 'customer', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('user_id', userId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as Order[];
    },
    enabled: !!userId,
  });
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

/** Staff: all pending orders with profile names */
export function useStaffPendingOrders(enabled: boolean) {
  return useQuery({
    queryKey: ['orders', 'staff-pending'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('id, status, created_at, service_type, user_id')
        .neq('status', 'entregue')
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;

      const orders = (data ?? []) as Order[];
      const userIds = [...new Set(orders.map(o => o.user_id).filter(Boolean))] as string[];

      if (userIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('user_id, name')
          .in('user_id', userIds);
        const nameMap = new Map(profiles?.map(p => [p.user_id, p.name]) || []);
        orders.forEach(o => {
          if (o.user_id) o.profiles = { name: nameMap.get(o.user_id) || 'Cliente' };
        });
      }

      return orders;
    },
    enabled,
  });
}

/** Staff: customer count */
export function useCustomerCount(enabled: boolean) {
  return useQuery({
    queryKey: ['customers', 'count'],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .or('is_employee.is.null,is_employee.eq.false');
      if (error) throw error;
      return count ?? 0;
    },
    enabled,
  });
}
