import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { StandardProcess } from '@/lib/standard-process/types';

export function useStandardProcess(id: string | null) {
  return useQuery({
    queryKey: ['standard-process', id],
    enabled: !!id,
    queryFn: async (): Promise<StandardProcess | null> => {
      if (!id) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('standard_processes') as any)
        .select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return (data as StandardProcess) ?? null;
    },
  });
}
