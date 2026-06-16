import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { TintPriceBreakdown } from '@/lib/tint/compute-price';

// O preço vem da RPC SECURITY DEFINER `get_tint_price` (hardening da receita:
// `tint_formula_itens` deixou de ser legível diretamente por cliente). A RPC
// computa o custo server-side e devolve só o agregado (`custoCorantes`/
// `precoFinal`) ao cliente; a receita (`itensCorantes`) só volta preenchida para
// staff. O cálculo puro de referência — oráculo de paridade do SQL — vive em
// @/lib/tint/compute-price (testado), e os tipos são re-exportados aqui para
// manter a API pública do hook estável.
export type { TintCoranteItem, TintPriceBreakdown } from '@/lib/tint/compute-price';

export function useTintPricing(formulaId: string | null) {
  return useQuery({
    queryKey: ['tint-pricing', formulaId],
    staleTime: 5 * 60 * 1000,
    enabled: !!formulaId,
    queryFn: async (): Promise<TintPriceBreakdown | null> => {
      if (!formulaId) return null;

      const { data, error } = await supabase
        .rpc('get_tint_price' as never, { p_formula_id: formulaId } as never);

      if (error || !data) return null;
      return data as unknown as TintPriceBreakdown;
    },
  });
}
