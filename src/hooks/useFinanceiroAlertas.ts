import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Conta títulos a pagar atrasados (fin_contas_pagar).
 * Retorna null se a tabela estiver indisponível ou em caso de erro,
 * para que a UI possa optar por não exibir o badge.
 */
export function useFinanceiroAlertas() {
  return useQuery<number | null>({
    queryKey: ['financeiro-alertas-atrasado-count'],
    queryFn: async () => {
      try {
        const { count, error } = await (supabase as any)
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
    staleTime: 30000,
  });
}
