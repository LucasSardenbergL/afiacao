import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Lista de specs aprovadas do KB (kb_product_specs).
 *
 * Tabela chega em PR6b. Enquanto não existe, retorna [] silenciosamente
 * em vez de explodir — o consumidor (StandardProcessForm) usa só pra hint.
 */
export interface KbProductSpec {
  id: string;
  product_code: string;
  supplier: string | null;
  product_name: string | null;
}

export function useKbProductSpecsList() {
  return useQuery({
    queryKey: ['kb-product-specs'],
    staleTime: 60_000,
    queryFn: async (): Promise<KbProductSpec[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('kb_product_specs') as any)
        .select('id, product_code, supplier, product_name')
        .order('product_code', { ascending: true })
        .limit(500);
      if (error) {
        // Tabela ainda não existe (PR6b pendente) — degrada silenciosamente
        return [];
      }
      return (data ?? []) as KbProductSpec[];
    },
  });
}
