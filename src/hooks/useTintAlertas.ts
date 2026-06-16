import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Conta importações tintométricas (tint_importacoes) com erros
 * (registros_erro > 0) na conta 'oben' nos últimos 60 dias.
 * Retorna null em caso de erro / tabela indisponível.
 *
 * `enabled` é OBRIGATÓRIO — ver nota em useAlertasCriticos (sem gate, usuários
 * não-staff polavam a tabela a cada 60s contra RLS que nega).
 */
export function useTintAlertas(enabled: boolean) {
  return useQuery<number | null>({
    queryKey: ['tint-alertas-erros-count'],
    enabled,
    queryFn: async () => {
      try {
        const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
        const { count, error } = await supabase
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
    refetchIntervalInBackground: false,
    staleTime: 30000,
  });
}
