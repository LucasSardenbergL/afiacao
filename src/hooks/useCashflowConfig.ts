import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type CashflowConfig = {
  company: string;
  overrides_cenario: {
    otimista: { recebimento_no_prazo_pct_delta: number; inadimplencia_pct_delta: number };
    pessimista: { recebimento_no_prazo_pct_delta: number; inadimplencia_pct_delta: number };
  };
  thresholds: {
    caixa_negativo_semanas: number;
    ncg_deficit_alerta: number;
    dias_cobertura_min: number;
    inadimplencia_max_pct: number;
    concentracao_top1_max_pct: number;
    pmr_crescimento_max_pct_90d: number;
  };
  adiantamento_categorias_codigos: string[];
};

export function useCashflowConfig(company: string) {
  return useQuery({
    queryKey: ['fin_config_cashflow', company],
    enabled: Boolean(company),
    queryFn: async (): Promise<CashflowConfig | null> => {
      const { data, error } = await supabase
        .from('fin_config_cashflow')
        .select('*')
        .eq('company', company)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as CashflowConfig | null;
    },
  });
}

export function useUpdateCashflowConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { company: string; patch: Partial<Omit<CashflowConfig, 'company'>> }) => {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const { error } = await supabase
        .from('fin_config_cashflow')
        .update({ ...input.patch, updated_at: new Date().toISOString(), updated_by: userId })
        .eq('company', input.company);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_config_cashflow'] });
      qc.invalidateQueries({ queryKey: ['fin_cashflow_projection'] });
    },
  });
}
