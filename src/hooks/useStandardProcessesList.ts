import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { StandardProcess, StandardProcessStatus } from '@/lib/standard-process/types';

interface Filters {
  status?: StandardProcessStatus[];
  segmento?: string;
}

export function useStandardProcessesList(filters: Filters = {}) {
  return useQuery({
    queryKey: ['standard-processes', filters],
    staleTime: 30_000,
    queryFn: async (): Promise<StandardProcess[]> => {
       
      let q = supabase.from('standard_processes').select('*');
      const statusList = filters.status ?? ['draft', 'in_review', 'published'];
      q = q.in('status', statusList);
      if (filters.segmento) q = q.eq('segmento', filters.segmento);
      q = q.order('updated_at', { ascending: false }).limit(200);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as StandardProcess[];
    },
  });
}
