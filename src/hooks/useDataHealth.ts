import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { DataHealthCheck } from '@/lib/dataHealth/types';
import { paraDataHealthCheck } from '@/lib/dataHealth/borda';

/**
 * `enabled` default true preserva os consumidores de página (SaudeDados,
 * useExcecoesGestor — rotas já gated). O DataHealthBadge do topbar DEVE passar
 * `isStaff`: sem isso, todo usuário logado (cliente incluso) executava a RPC
 * de 14 checks no servidor a cada 2 minutos.
 */
export function useDataHealth(enabled = true) {
  return useQuery<DataHealthCheck[]>({
    queryKey: ['data-health'],
    enabled,
    staleTime: 60_000,
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_data_health');
      if (error) throw error;
      return (data ?? []).map(paraDataHealthCheck);
    },
  });
}
