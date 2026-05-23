import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export interface FarmerKpis {
  calls_today: number;
  revenue_today: number;
  margin_today: number;
  avg_ticket_today: number;
  pending_link_count: number;
}

/**
 * KPIs do dia pro vendedor logado, agregados de farmer_calls.
 */
export function useMyKpis() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-kpis', user?.id],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async (): Promise<FarmerKpis> => {
      if (!user) {
        return { calls_today: 0, revenue_today: 0, margin_today: 0, avg_ticket_today: 0, pending_link_count: 0 };
      }
      const todayIso = new Date().toISOString().slice(0, 10);

       
      const { data: calls } = await supabase.from('farmer_calls')
        .select('revenue_generated, margin_generated')
        .eq('farmer_id', user.id)
        .gte('started_at', todayIso);

      const callsArr = (calls ?? []) as Array<{ revenue_generated: number | null; margin_generated: number | null }>;
      const revenue = callsArr.reduce((s, c) => s + Number(c.revenue_generated ?? 0), 0);
      const margin = callsArr.reduce((s, c) => s + Number(c.margin_generated ?? 0), 0);
      const withRevenue = callsArr.filter((c) => Number(c.revenue_generated ?? 0) > 0);

       
      const { count: pending } = await supabase.from('farmer_calls')
        .select('id', { count: 'exact', head: true })
        .eq('farmer_id', user.id)
        .is('customer_user_id', null)
        .not('transcript', 'is', null);

      return {
        calls_today: callsArr.length,
        revenue_today: revenue,
        margin_today: margin,
        avg_ticket_today: withRevenue.length > 0 ? revenue / withRevenue.length : 0,
        pending_link_count: (pending as number) ?? 0,
      };
    },
  });
}
