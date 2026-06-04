import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { montarKpisVisita, type KpisVisita, type KpiVisitaRow } from '@/lib/visitas/kpis';

/**
 * KPIs das visitas do vendedor logado numa janela (default 30d). route_visits own-scoped
 * (visited_by=eu, RLS #340). Read-only. Definições em src/lib/visitas/kpis.ts.
 */
export function useKpisVisita(janelaDias = 30) {
  const { user } = useAuth();
  const uid = user?.id;
  return useQuery({
    queryKey: ['kpis-visita', uid, janelaDias],
    enabled: !!uid,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<KpisVisita> => {
      if (!uid) return montarKpisVisita([]);
      const desde = new Date(Date.now() - janelaDias * 86_400_000).toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('route_visits')
        .select('result, revenue_generated')
        .eq('visited_by', uid)
        .gte('visit_date', desde);
      if (error) throw new Error(error.message);
      return montarKpisVisita((data ?? []) as KpiVisitaRow[]);
    },
  });
}
