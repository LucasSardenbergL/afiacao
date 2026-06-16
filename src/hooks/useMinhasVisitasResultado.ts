import { useQuery } from '@tanstack/react-query';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { supabase } from '@/integrations/supabase/client';
import type { VisitaConversaoRow } from '@/lib/visitas/conversao';

/**
 * Visitas do vendedor numa janela (route_visits onde visited_by = id efetivo), só os
 * campos pro breakdown de conversão (result + revenue). RLS #340: own + branch
 * gestor/master (este cobre a leitura do ALVO na lente "Ver como"). Read-only.
 */
export function useMinhasVisitasResultado(janelaDias: number) {
  // Lente "Ver como": id efetivo = ALVO na lente, próprio usuário fora dela.
  const { effectiveUserId: uid } = useImpersonation();
  return useQuery({
    queryKey: ['minhas-visitas-resultado', uid, janelaDias],
    enabled: !!uid,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<VisitaConversaoRow[]> => {
      if (!uid) return [];
      const desde = new Date(Date.now() - janelaDias * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from('route_visits')
        .select('result, revenue_generated')
        .eq('visited_by', uid)
        .gte('check_in_at', desde);
      if (error) throw new Error(error.message);
      return (data ?? []) as VisitaConversaoRow[];
    },
  });
}
