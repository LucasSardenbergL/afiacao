import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { KbDocument } from '@/lib/knowledge-base/types';

interface Filters {
  status?: string[];
  type?: string;
  supplier?: string;
}

export function useKnowledgeBaseList(filters: Filters = {}) {
  return useQuery({
    queryKey: ['kb-documents', filters],
    staleTime: 30_000,
    queryFn: async (): Promise<KbDocument[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q = (supabase.from('kb_documents') as any).select('*');
      const statusList = filters.status ?? ['ready', 'processing'];
      q = q.in('status', statusList);
      if (filters.type) q = q.eq('type', filters.type);
      if (filters.supplier) q = q.eq('supplier', filters.supplier);
      q = q.order('created_at', { ascending: false }).limit(100);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as KbDocument[];
    },
  });
}
