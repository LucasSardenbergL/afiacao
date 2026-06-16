import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Conta alertas críticos pendentes (eventos_outlier).
 * Retorna null se a tabela estiver indisponível ou em caso de erro,
 * para que a UI possa optar por não exibir o badge.
 *
 * `enabled` é OBRIGATÓRIO: o consumidor decide o gate (no AppShell é
 * `isStaff && !isSalesOnly`) — sem ele, cliente final e vendedor sales-only
 * polavam essa tabela a cada 60s contra RLS que nega (retry 2 = 9 req/min
 * desperdiçados por usuário).
 */
export function useAlertasCriticos(enabled: boolean) {
  return useQuery<number | null>({
    queryKey: ['alertas-criticos-count'],
    enabled,
    queryFn: async () => {
      try {
        const { count, error } = await supabase
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
    refetchIntervalInBackground: false,
    staleTime: 30000,
  });
}
