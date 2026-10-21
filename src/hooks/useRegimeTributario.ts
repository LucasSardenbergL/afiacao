// src/hooks/useRegimeTributario.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { RegimeTributarioResult, RegimeInputs } from '@/services/financeiroService';

export function useRegimeTributario() {
  return useQuery({
    queryKey: ['fin_regime_tributario'],
    queryFn: async (): Promise<RegimeTributarioResult> => {
      const { data, error } = await supabase.functions.invoke('fin-regime-tributario', { body: {} });
      if (error) throw error;
      return data as RegimeTributarioResult;
    },
  });
}

export function useUpdateRegimeInputs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ company, regime_inputs }: { company: string; regime_inputs: RegimeInputs }) => {
      // Tabela master-only dedicada (RLS exige role 'master'). upsert cobre o caso de a linha de seed
      // não existir; o form é pré-preenchido com os inputs atuais, então o replace é seguro.
      const { error } = await supabase.from('fin_regime_inputs').upsert(
        { company, regime_inputs, updated_at: new Date().toISOString() },
        { onConflict: 'company' },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_regime_tributario'] });
    },
  });
}
