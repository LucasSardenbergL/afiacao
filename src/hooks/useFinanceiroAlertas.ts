import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Conta títulos a pagar atrasados (fin_contas_pagar).
 * Retorna null se a tabela estiver indisponível ou em caso de erro,
 * para que a UI possa optar por não exibir o badge.
 *
 * `enabled` é OBRIGATÓRIO — ver nota em useAlertasCriticos (sem gate, usuários
 * não-staff polavam a tabela a cada 60s contra RLS que nega).
 */
export function useFinanceiroAlertas(enabled: boolean) {
  return useQuery<number | null>({
    queryKey: ['financeiro-alertas-atrasado-count'],
    enabled,
    queryFn: async () => {
      try {
        const { count, error } = await supabase
          .from('fin_contas_pagar')
          .select('*', { count: 'exact', head: true })
          .eq('status_titulo', 'ATRASADO');
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
