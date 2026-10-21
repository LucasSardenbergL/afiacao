import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { paraCashflowConfig, type CashflowConfig } from '@/lib/financeiro/borda-tabelas';

export type { CashflowConfig };

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
      return data ? paraCashflowConfig(data) : null;
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
