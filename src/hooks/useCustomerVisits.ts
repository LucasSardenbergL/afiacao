import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface CustomerVisitRow {
  id: string;
  visited_by: string;
  visit_date: string;
  check_in_at: string | null;
  check_out_at: string | null;
  result: string | null;
  notes: string | null;
  revenue_generated: number | null;
  order_created: boolean | null;
  visitedByName: string;
}

/**
 * Histórico de visitas (route_visits) de um cliente, com resultado/receita/notas.
 * RLS de route_visits (endurecida no #340) filtra own/carteira/gestor — degradação honesta.
 * Read-only.
 */
export function useCustomerVisits(customerId: string | null) {
  return useQuery({
    queryKey: ['customer-visits', customerId],
    enabled: !!customerId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<CustomerVisitRow[]> => {
      if (!customerId) return [];
      const { data, error } = await supabase
        .from('route_visits')
        .select('id, visited_by, visit_date, check_in_at, check_out_at, result, notes, revenue_generated, order_created')
        .eq('customer_user_id', customerId)
        .order('check_in_at', { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);

      const rows = data ?? [];
      if (rows.length === 0) return [];

      const ids = [...new Set(rows.map((r) => r.visited_by).filter(Boolean))];
      const { data: profs } = await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', ids);
      const nameMap = new Map((profs ?? []).map((p) => [p.user_id, p.name]));

      return rows.map((r) => ({ ...r, visitedByName: nameMap.get(r.visited_by) || 'Vendedor' }));
    },
  });
}
