// src/hooks/useFunding.ts
// Espelha useRegimeTributario.ts: useQuery → invoke, useMutation → upsert, cast through unknown.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { FundingResult, FundingInputs } from '@/services/financeiroService';

export function useFunding(company: string) {
  return useQuery({
    queryKey: ['fin_funding', company],
    enabled: Boolean(company),
    queryFn: async (): Promise<FundingResult> => {
      const { data, error } = await supabase.functions.invoke('fin-funding', {
        body: { company },
      });
      if (error) throw error;
      return data as FundingResult;
    },
  });
}

export function useFundingInputs(company: string) {
  return useQuery({
    queryKey: ['fin_funding_inputs', company],
    enabled: Boolean(company),
    queryFn: async (): Promise<FundingInputs | null> => {
      // Tabela master-only (RLS). Cast through unknown: mesma razão do useRegimeTributario.ts —
      // fin_funding_inputs não está nos tipos gerados e a versão de postgrest-js do Lovable difere.
      const client = supabase as unknown as {
        from: (table: string) => {
          select: (cols: string) => {
            eq: (col: string, val: string) => {
              maybeSingle: () => Promise<{
                data: { funding_inputs: unknown } | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
      const { data, error } = await client
        .from('fin_funding_inputs')
        .select('funding_inputs')
        .eq('company', company)
        .maybeSingle();
      if (error) throw error;
      return (data?.funding_inputs ?? null) as FundingInputs | null;
    },
  });
}

export function useSalvarFundingInputs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      company,
      funding_inputs,
    }: {
      company: string;
      funding_inputs: FundingInputs;
    }) => {
      // `fin_funding_inputs` não está no types.ts gerado. Cast through `unknown` (sem `any`) para
      // shape mínimo do client — independe de versão do postgrest-js e da tabela estar nos tipos.
      // Padrão verbatim de useRegimeTributario.ts.
      const client = supabase as unknown as {
        from: (table: string) => {
          upsert: (
            values: Record<string, unknown>,
            options: { onConflict: string },
          ) => Promise<{ error: { message: string } | null }>;
        };
      };
      const { error } = await client.from('fin_funding_inputs').upsert(
        { company, funding_inputs, updated_at: new Date().toISOString() },
        { onConflict: 'company' },
      );
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['fin_funding', vars.company] });
      qc.invalidateQueries({ queryKey: ['fin_funding_inputs', vars.company] });
      toast.success('Inputs salvos. Recalculando…');
    },
    onError: (e) => {
      toast.error('Falha ao salvar inputs', {
        description: e instanceof Error ? e.message : String(e),
      });
    },
  });
}
