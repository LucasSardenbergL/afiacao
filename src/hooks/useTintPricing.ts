import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TintCoranteItem {
  coranteDescricao: string;
  qtdMl: number;
  custoPorMl: number;
  custoItem: number;
  custoDisponivel: boolean;
}

export interface TintPriceBreakdown {
  custoBase: number;
  itensCorantes: TintCoranteItem[];
  custoCorantes: number;
  precoFinal: number;
}

export function useTintPricing(formulaId: string | null) {
  return useQuery({
    queryKey: ['tint-pricing', formulaId],
    staleTime: 5 * 60 * 1000,
    enabled: !!formulaId,
    queryFn: async (): Promise<TintPriceBreakdown | null> => {
      if (!formulaId) return null;

      // Get formula items with corante details
      const { data: items, error } = await supabase
        .from('tint_formula_itens')
        .select('qtd_ml, ordem, corante_id')
        .eq('formula_id', formulaId)
        .order('ordem');

      if (error || !items) return null;

      // Get all corante ids
      const coranteIds = items.map(i => i.corante_id);
      const { data: corantes } = await supabase
        .from('tint_corantes')
        .select('id, descricao, volume_total_ml, omie_product_id')
        .in('id', coranteIds);

      if (!corantes) return null;

      // Get omie products for cost
      const omieIds = corantes.filter(c => c.omie_product_id).map(c => c.omie_product_id!);
      let omieProducts: Record<string, { valor_unitario: number }> = {};
      if (omieIds.length > 0) {
        const { data: prods } = await supabase
          .from('omie_products')
          .select('id, valor_unitario')
          .in('id', omieIds);
        if (prods) {
          for (const p of prods) omieProducts[p.id] = { valor_unitario: p.valor_unitario };
        }
      }

      const itensCorantes: TintCoranteItem[] = items.map(item => {
        const corante = corantes.find(c => c.id === item.corante_id);
        if (!corante) return { coranteDescricao: '?', qtdMl: item.qtd_ml, custoPorMl: 0, custoItem: 0, custoDisponivel: false };

        const omie = corante.omie_product_id ? omieProducts[corante.omie_product_id] : null;
        const custoDisponivel = !!omie && !!corante.volume_total_ml && corante.volume_total_ml > 0;
        const custoPorMl = custoDisponivel ? omie!.valor_unitario / corante.volume_total_ml : 0;
        const custoItem = item.qtd_ml * custoPorMl;

        return {
          coranteDescricao: corante.descricao,
          qtdMl: item.qtd_ml,
          custoPorMl,
          custoItem,
          custoDisponivel,
        };
      });

      const custoCorantes = itensCorantes.reduce((sum, i) => sum + i.custoItem, 0);

      return { custoBase: 0, itensCorantes, custoCorantes, precoFinal: custoCorantes };
    },
  });
}
