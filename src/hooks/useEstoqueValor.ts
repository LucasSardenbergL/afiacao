import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';

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

/**
 * Estoque de GIRO do Omie (sem imobilizado / uso e consumo — regra única no banco,
 * `_fin_estoque_classe`). Só pré-preenche o campo: o motor já usa este valor sozinho quando não
 * há inventário manual dos últimos 45 dias. Sem SKU de giro com custo → lança (nunca R$ 0).
 */
export async function estimarEstoqueOmie(company: string) {
  // Set-returning (1 linha por empresa hoje): paginado mesmo assim — a capa de 1.000 do PostgREST vale para .rpc().
  const linhas = await fetchAllPages(
    (de, ate) => supabase.rpc('fin_estoque_giro_valor', { p_company: company })
      .order('valor_giro', { ascending: true }).range(de, ate),
    'fin_estoque_giro_valor',
  );
  const row = (linhas[0] ?? null) as {
    valor_giro: number | null; skus_giro: number; skus_giro_com_custo: number; cobertura_pct: number | null;
  } | null;
  if (!row || row.valor_giro == null) throw new Error('Sem estoque de giro com custo no Omie para esta empresa');
  return {
    valor_estimado: Number(row.valor_giro),
    cobertura_pct: Number(row.cobertura_pct),
    skus_total: Number(row.skus_giro),
    skus_com_custo: Number(row.skus_giro_com_custo),
  };
}
