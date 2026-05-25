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
      // `fin_regime_inputs` é nova e ainda não está no types.ts gerado — e a versão de postgrest-js do
      // dev-server do Lovable difere da do repo. O cast `as ReturnType<typeof supabase.from>` estourava
      // TS2589 (deep instantiation) / TS2352 no postgrest-js novo. Acessamos por um shape MÍNIMO do
      // client (cast através de `unknown`, sem `any`): independe da versão e de a tabela estar nos tipos.
      const client = supabase as unknown as {
        from: (table: string) => {
          upsert: (
            values: Record<string, unknown>,
            options: { onConflict: string },
          ) => Promise<{ error: { message: string } | null }>;
        };
      };
      const { error } = await client.from('fin_regime_inputs').upsert(
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
