import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { KbProductSpec } from '@/lib/knowledge-base/specs-types';

/**
 * ⚠️ ADMIN-ONLY. Lê a ficha por `product_code` SEM filtrar `approved_at` (o detalhe precisa
 * ver o rascunho não-aprovado). A VENDA/COPILOT NUNCA devem usar este hook — leem a fonte
 * única `v_omie_product_current_spec` (dupla-trava confirmed + approved_at). Ver
 * docs/superpowers/specs/2026-06-13-kb-0c-aprovacao-master-only-design.md §4e.
 */
export function useKbProductSpecs(productCode: string | undefined | null) {
  return useQuery({
    queryKey: ['kb-product-spec', productCode],
    enabled: !!productCode,
    staleTime: 60_000,
    queryFn: async (): Promise<KbProductSpec | null> => {
      if (!productCode) return null;
      const { data, error } = await supabase.from('kb_product_specs')
        .select('*')
        .eq('product_code', productCode)
        .maybeSingle();
      if (error) throw error;
      return (data as KbProductSpec) ?? null;
    },
  });
}
