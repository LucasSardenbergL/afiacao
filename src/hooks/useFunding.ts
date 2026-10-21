// src/hooks/useFunding.ts
// Espelha useRegimeTributario.ts: useQuery → invoke, useMutation → upsert. fin_funding_inputs é master-only (RLS).
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { FundingResult, FundingInputs } from '@/services/financeiroService';
import { lerFundingInputsSalvos, type FundingInputsSalvos } from '@/lib/financeiro/borda-tabelas';
import { mensagemDeErro } from '@/lib/erro-mensagem';

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
    queryFn: async (): Promise<FundingInputsSalvos | null> => {
      const { data, error } = await supabase
        .from('fin_funding_inputs')
        .select('funding_inputs')
        .eq('company', company)
        .maybeSingle();
      if (error) throw error;
      // Sem linha = nada salvo. Com linha, o jsonb é PARCIAL (em prod hoje é `{}`): lido por forma.
      return data ? lerFundingInputsSalvos(data.funding_inputs, `fin_funding_inputs ${company}`) : null;
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
      const { error } = await supabase.from('fin_funding_inputs').upsert(
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
        description: mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.',
      });
    },
  });
}
