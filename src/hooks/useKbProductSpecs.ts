import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { KbProductSpec } from '@/lib/knowledge-base/specs-types';

export function useKbProductSpecs(productCode: string | undefined | null) {
  return useQuery({
    queryKey: ['kb-product-spec', productCode],
    enabled: !!productCode,
    staleTime: 60_000,
    queryFn: async (): Promise<KbProductSpec | null> => {
      if (!productCode) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('kb_product_specs') as any)
        .select('*')
        .eq('product_code', productCode)
        .maybeSingle();
      if (error) throw error;
      return (data as KbProductSpec) ?? null;
    },
  });
}
