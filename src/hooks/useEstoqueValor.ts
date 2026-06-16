import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type EstoqueValor = { valor: number; data_ref: string; fonte: string; cobertura_pct: number | null };

export function useEstoqueValor(company: string) {
  return useQuery({
    queryKey: ['fin_estoque_valor', company],
    enabled: Boolean(company),
    queryFn: async (): Promise<EstoqueValor | null> => {
      const { data, error } = await supabase.from('fin_estoque_valor')
        .select('valor, data_ref, fonte, cobertura_pct')
        .eq('company', company).order('data_ref', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return (data as EstoqueValor | null) ?? null;
    },
  });
}

export function useSalvarEstoque(company: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { valor: number; data_ref: string; fonte?: string; cobertura_pct?: number; observacao?: string }) => {
      const { error } = await supabase.from('fin_estoque_valor').insert({
        company, valor: input.valor, data_ref: input.data_ref,
        fonte: input.fonte ?? 'manual', cobertura_pct: input.cobertura_pct ?? null,
        observacao: input.observacao ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fin_estoque_valor', company] }),
  });
}

export async function estimarEstoqueOmie(company: string) {
  const { data, error } = await supabase.rpc('fin_estimar_estoque_omie', { p_company: company });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as { valor_estimado: number; cobertura_pct: number; skus_total: number; skus_com_custo: number };
}
