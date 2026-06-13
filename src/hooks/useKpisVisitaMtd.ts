import { useQuery } from '@tanstack/react-query';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { supabase } from '@/integrations/supabase/client';
import { hojeSP, inicioMes } from '@/lib/dashboard/sp-date';
import { montarKpisVisita, type KpisVisita, type KpiVisitaRow } from '@/lib/visitas/kpis';

/**
 * KPIs de visita do vendedor no MÊS corrente (MTD, fuso SP) — o PLACAR do closer.
 * Distinto do useKpisVisita (30d rolling, eficiência): aqui a janela é o mês
 * calendário (alinha ao ciclo de quota/OTE). Mesma fonte (route_visits own-scoped,
 * visited_by=eu, RLS #340) e o MESMO helper puro montarKpisVisita.
 * Lente "Ver como": id efetivo = ALVO na lente, próprio usuário fora dela. Read-only.
 */
export function useKpisVisitaMtd() {
  const { effectiveUserId: uid } = useImpersonation();
  const desde = inicioMes(hojeSP()); // 1º dia do mês corrente em SP
  return useQuery({
    queryKey: ['kpis-visita-mtd', uid, desde],
    enabled: !!uid,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<KpisVisita> => {
      if (!uid) return montarKpisVisita([]);
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
