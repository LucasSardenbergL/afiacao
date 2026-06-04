import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import type { VisitaConversaoRow } from '@/lib/visitas/conversao';

/**
 * Visitas do vendedor logado (route_visits onde visited_by = eu) numa janela de dias,
 * só os campos pro breakdown de conversão (result + revenue). RLS own-scoped (#340). Read-only.
 */
export function useMinhasVisitasResultado(janelaDias: number) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['minhas-visitas-resultado', user?.id, janelaDias],
    enabled: !!user?.id,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<VisitaConversaoRow[]> => {
      if (!user?.id) return [];
      const desde = new Date(Date.now() - janelaDias * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from('route_visits')
        .select('result, revenue_generated')
        .eq('visited_by', user.id)
        .gte('check_in_at', desde);
      if (error) throw new Error(error.message);
      return (data ?? []) as VisitaConversaoRow[];
    },
  });
}
