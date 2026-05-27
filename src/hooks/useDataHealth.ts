import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { DataHealthCheck } from '@/lib/dataHealth/types';

export function useDataHealth() {
  return useQuery<DataHealthCheck[]>({
    queryKey: ['data-health'],
    staleTime: 60_000,
    refetchInterval: 120_000,
    queryFn: async () => {
      // RPC ainda não está nos tipos gerados do Supabase — cast `as never`
      // segue o padrão do repo (ex.: AdminReposicaoOportunidades).
      const { data, error } = await supabase.rpc('get_data_health' as never);
      if (error) throw error;
      return (data ?? []) as unknown as DataHealthCheck[];
    },
  });
}
