import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Conta importações tintométricas (tint_importacoes) com erros
 * (registros_erro > 0) na conta 'oben' nos últimos 30 dias.
 * Retorna null em caso de erro / tabela indisponível.
 */
export function useTintAlertas() {
  return useQuery<number | null>({
    queryKey: ['tint-alertas-erros-count'],
    queryFn: async () => {
      try {
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const { count, error } = await (supabase as any)
          .from('tint_importacoes')
          .select('*', { count: 'exact', head: true })
          .eq('account', 'oben')
          .gt('registros_erro', 0)
          .gte('created_at', since);
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
