import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { hojeISO } from '@/lib/visitas/today';
import { montarVisitasHoje, type VisitasHojeResumo } from '@/lib/visitas/visitas-hoje';

/**
 * Visitas de `visitas_agendadas` pendentes, agendadas pelo usuário logado, para HOJE.
 * "Hoje" = hojeISO() (UTC), consistente com loadScheduledVisits do route planner.
 * Enriquece com o nome do cliente (profiles). Read-only.
 */
export function useVisitasHoje(): { resumo: VisitasHojeResumo; isLoading: boolean } {
  const { user } = useAuth();
  const uid = user?.id;

  const query = useQuery({
    queryKey: ['visitas-hoje', uid],
    enabled: !!uid,
    queryFn: async (): Promise<VisitasHojeResumo> => {
      const { data: rows, error } = await supabase
        .from('visitas_agendadas')
        .select('id, customer_user_id')
        .eq('scheduled_by', uid!)
        .eq('status', 'pendente')
        .eq('scheduled_date', hojeISO())
        .order('scheduled_date', { ascending: true });
      if (error) throw new Error(error.message);

      const lista = rows ?? [];
      if (lista.length === 0) return { total: 0, preview: [] };

      const ids = [...new Set(lista.map((r) => r.customer_user_id))];
      const { data: profs } = await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', ids);
      const nameMap = new Map((profs ?? []).map((p) => [p.user_id, p.name]));

      return montarVisitasHoje(lista, nameMap);
    },
  });

  return { resumo: query.data ?? { total: 0, preview: [] }, isLoading: query.isLoading };
}
