import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { KbProductSpec } from '@/lib/knowledge-base/specs-types';

export function useKbProductSpecsList() {
  return useQuery({
    queryKey: ['kb-product-specs-list'],
    staleTime: 60_000,
    queryFn: async (): Promise<KbProductSpec[]> => {
      const { data, error } = await supabase.from('kb_product_specs')
        .select('*')
        .not('approved_at', 'is', null)
        .order('product_name', { ascending: true })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as KbProductSpec[];
    },
  });
}
