import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { TintPriceBreakdown } from '@/lib/tint/compute-price';
import type { TintPriceBreakdownLite } from '@/lib/tint/select-price';

// O preço vem da RPC SECURITY DEFINER `get_tint_price` (hardening da receita:
// `tint_formula_itens` deixou de ser legível diretamente por cliente). A RPC
// computa o custo server-side e devolve só o agregado (`custoCorantes`/
// `precoFinal`) ao cliente; a receita (`itensCorantes`) só volta preenchida para
// staff. O cálculo puro de referência — oráculo de paridade do SQL — vive em
// @/lib/tint/compute-price (testado), e os tipos são re-exportados aqui para
// manter a API pública do hook estável.
export type { TintPriceBreakdown } from '@/lib/tint/compute-price';

export function useTintPricing(formulaId: string | null) {
  return useQuery({
    queryKey: ['tint-pricing', formulaId],
    staleTime: 5 * 60 * 1000,
    enabled: !!formulaId,
    queryFn: async (): Promise<TintPriceBreakdown | null> => {
      if (!formulaId) return null;

      const { data, error } = await supabase
        .rpc('get_tint_price' as never, { p_formula_id: formulaId } as never);

      // Erro real (rede/permissão/runtime) → PROPAGA (throw): react-query expõe isError e o balcão
      // fail-closa (sem preço) em vez de mascarar como null e cair no CSV legado — o que venderia
      // base/corante inativo que a RPC barra. A RPC sempre devolve objeto p/ fórmula válida.
      if (error) throw error;
      return (data ?? null) as unknown as TintPriceBreakdown | null;
    },
  });
}

// Versão BATCH (get_tint_prices): calcula N fórmulas num query só e devolve um mapa
// { formulaId: breakdown }. Usada pelas "outras embalagens" e pela "busca global",
// onde uma cor aparece em várias bases — N chamadas single seria N round-trips. NÃO
// traz a receita (itensCorantes): só o agregado de preço (precoFinal/baseDisponivel/…).
export function useTintPrices(formulaIds: string[]) {
  const ids = [...new Set(formulaIds)].sort(); // dedupe + estável p/ a queryKey não oscilar
  return useQuery({
    queryKey: ['tint-prices-batch', ids],
    staleTime: 5 * 60 * 1000,
    enabled: ids.length > 0,
    queryFn: async (): Promise<Record<string, TintPriceBreakdownLite>> => {
      const { data, error } = await supabase
        .rpc('get_tint_prices' as never, { p_formula_ids: ids } as never);

      if (error || !data) return {};
      return data as unknown as Record<string, TintPriceBreakdownLite>;
    },
  });
}
