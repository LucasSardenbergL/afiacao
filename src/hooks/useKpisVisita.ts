import { useQuery } from '@tanstack/react-query';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { supabase } from '@/integrations/supabase/client';
import { addDias, hojeSP } from '@/lib/time/sp-day';
import { montarKpisVisita, type KpisVisita, type KpiVisitaRow } from '@/lib/visitas/kpis';

/**
 * KPIs das visitas do vendedor logado numa janela (default 30d). route_visits own-scoped
 * (visited_by=eu, RLS #340). Read-only. Definições em src/lib/visitas/kpis.ts.
 */
export function useKpisVisita(janelaDias = 30) {
  // Lente "Ver como": id efetivo = ALVO na lente, próprio usuário fora dela.
  const { effectiveUserId: uid } = useImpersonation();
  return useQuery({
    queryKey: ['kpis-visita', uid, janelaDias],
    enabled: !!uid,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<KpisVisita> => {
      if (!uid) return montarKpisVisita([]);
      // O dia de SP, o mesmo do DEFAULT de visit_date (20261001043717): a borda não anda às 21h BRT.
      const desde = addDias(hojeSP(), -janelaDias);
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
