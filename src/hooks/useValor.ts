// src/hooks/useValor.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
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
      // Tabela master-only dedicada (RLS exige role 'master'). upsert cobre o caso de a linha
      // de seed não existir. O form é pré-preenchido com os inputs atuais, então o replace é seguro.
      const { error } = await supabase
        .from('fin_valor_inputs')
        .upsert(
          { company, valor_inputs: valor_inputs as unknown as Json, updated_at: new Date().toISOString() },
          { onConflict: 'company' },
        );
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['fin_valor', vars.company] });
    },
  });
}
