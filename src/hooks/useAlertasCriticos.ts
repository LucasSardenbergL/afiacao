import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Chave ÚNICA da contagem de outliers pendentes (crítico + atenção). O shell lê o mesmo número
 * para dois badges (/admin/reposicao/alertas e o destrutivo de /sessao/parametros) — antes eram
 * duas queryKeys com a MESMA consulta, 2 req/min onde basta 1 (plano v5, F4 fatia 1). Quem muda
 * `eventos_outlier` invalida por esta constante, e os dois badges andam juntos.
 */
export const CHAVE_OUTLIER_PENDENTES_COUNT = ['outlier-pendentes-count'] as const;

/**
 * Conta alertas pendentes (eventos_outlier, crítico + atenção).
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
    queryKey: CHAVE_OUTLIER_PENDENTES_COUNT,
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
