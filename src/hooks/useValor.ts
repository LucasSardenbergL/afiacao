// src/hooks/useValor.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ValorEmpresaResult, ValorInputs } from '@/services/financeiroService';

export function useValor(company: string) {
  return useQuery({
    queryKey: ['fin_valor', company],
    enabled: Boolean(company),
    queryFn: async (): Promise<ValorEmpresaResult> => {
      const { data, error } = await supabase.functions.invoke('fin-valor-engine', { body: { company } });
      if (error) throw error;
      return data as ValorEmpresaResult;
    },
  });
}

export function useUpdateValorInputs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ company, valor_inputs }: { company: string; valor_inputs: ValorInputs }) => {
      const { error } = await supabase
        .from('fin_config_cashflow')
        .update({ valor_inputs: valor_inputs as unknown as Record<string, unknown> })
        .eq('company', company);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['fin_valor', vars.company] });
    },
  });
}
