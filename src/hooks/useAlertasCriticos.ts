import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Conta alertas críticos pendentes (eventos_outlier).
 * Retorna null se a tabela estiver indisponível ou em caso de erro,
 * para que a UI possa optar por não exibir o badge.
 */
export function useAlertasCriticos() {
  return useQuery<number | null>({
    queryKey: ['alertas-criticos-count'],
    queryFn: async () => {
      try {
        const { count, error } = await (supabase as any)
          .from('eventos_outlier')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'pendente')
          .in('severidade', ['critico', 'atencao']);
        if (error) return null;
        return count ?? 0;
      } catch {
        return null;
      }
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });
}
