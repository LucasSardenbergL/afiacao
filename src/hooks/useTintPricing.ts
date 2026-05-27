import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { computeTintPrice, type TintCoranteInput, type TintOmiePriceMap } from '@/lib/tint/compute-price';

// O cálculo puro vive em @/lib/tint/compute-price (testado; money-path). Os tipos
// são re-exportados aqui para manter a API pública do hook estável.
export type { TintCoranteItem, TintPriceBreakdown } from '@/lib/tint/compute-price';

export function useTintPricing(formulaId: string | null) {
  return useQuery({
    queryKey: ['tint-pricing', formulaId],
    staleTime: 5 * 60 * 1000,
    enabled: !!formulaId,
    queryFn: async () => {
      if (!formulaId) return null;

      // Itens da fórmula (a "receita") + corantes + custo Omie.
      const { data: items, error } = await supabase
        .from('tint_formula_itens')
        .select('qtd_ml, ordem, corante_id')
        .eq('formula_id', formulaId)
        .order('ordem');

      if (error || !items) return null;

      const coranteIds = items.map(i => i.corante_id);
      const { data: corantes } = await supabase
        .from('tint_corantes')
        .select('id, descricao, volume_total_ml, omie_product_id')
        .in('id', coranteIds);

      if (!corantes) return null;

      const omieIds = corantes.filter(c => c.omie_product_id).map(c => c.omie_product_id!);
      const omieProducts: TintOmiePriceMap = {};
      if (omieIds.length > 0) {
        const { data: prods } = await supabase
          .from('omie_products')
          .select('id, valor_unitario')
          .in('id', omieIds);
        if (prods) {
          for (const p of prods) omieProducts[p.id] = { valor_unitario: p.valor_unitario };
        }
      }

      return computeTintPrice(items, corantes as TintCoranteInput[], omieProducts);
    },
  });
}
