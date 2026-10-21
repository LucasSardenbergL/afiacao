// src/hooks/useAntecipacoes.ts
// F4 — camada de dados (react-query). fin_antecipacoes é master-only (RLS). Cliente tipado pelo
// types.ts; company/tipo (CHECK) conferidos na borda (paraAntecipacao), que LANÇA fora do vocabulário.
// Soft delete: UPDATE deleted_at (nunca DELETE — preserva histórico de custo). Hurdle-sugestão
// derivada do F1 (fin_dividas.cet_aa ponderado pelo saldo devedor em aberto — fallback, P1-3).
import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { sugerirHurdle } from '@/lib/financeiro/antecipacao-helpers';
import { saldoDevedorEmAberto } from '@/lib/financeiro/endividamento-helpers';
import { useDividas, useParcelas } from '@/hooks/useEndividamento';
import type { TablesInsert } from '@/integrations/supabase/types';
import type { Antecipacao, Company, HurdleSugerido } from '@/lib/financeiro/antecipacao-types';
import { paraAntecipacao } from '@/lib/financeiro/borda-tabelas';
import { mensagemDeErro } from '@/lib/erro-mensagem';

const STALE = 60_000;

/** Operações vivas (deleted_at IS NULL) de uma empresa, mais recentes primeiro. */
export function useAntecipacoes(company: Company | string) {
  return useQuery({
    queryKey: ['antecipacoes', company],
    enabled: Boolean(company),
    staleTime: STALE,
    queryFn: async (): Promise<Antecipacao[]> => {
      const { data, error } = await supabase
        .from('fin_antecipacoes')
        .select('*')
        .eq('company', company)
        .order('data_operacao', { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []).filter((a) => a.deleted_at == null).map(paraAntecipacao);
    },
  });
}

/** Insert (sem id) ou update (com id). Trigger cuida de created_by/updated_by/at. */
export function useUpsertAntecipacao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (op: TablesInsert<'fin_antecipacoes'> & { company: Company }) => {
      const { error } = await supabase.from('fin_antecipacoes').upsert({ ...op }, { onConflict: 'id' });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['antecipacoes', v.company] });
      toast.success('Operação salva.');
    },
    onError: (e) =>
      toast.error('Falha ao salvar operação', {
        description: mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.',
      }),
  });
}

/** Soft delete: marca deleted_at (não apaga — preserva histórico de custo). */
export function useSoftDeleteAntecipacao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; company: Company }) => {
      const { error } = await supabase
        .from('fin_antecipacoes')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['antecipacoes', v.company] });
      toast.success('Operação removida.');
    },
    onError: (e) =>
      toast.error('Falha ao remover operação', {
        description: mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.',
      }),
  });
}

/** Hurdle-sugestão a partir do custo médio ponderado do CET das dívidas do F1 (fallback com unidade). */
export function useHurdleSugerido(company: Company | string): HurdleSugerido {
  const { data: dividas } = useDividas(company);
  const dividaIds = useMemo(() => (dividas ?? []).map((d) => d.id), [dividas]);
  const { data: parcelas } = useParcelas(dividaIds);
  return useMemo<HurdleSugerido>(() => {
    if (!dividas) return { valor: null, unidade: null, motivo: 'sem_dados' };
    return sugerirHurdle(
      dividas
        .filter((d) => d.ativo)
        .map((d) => ({ saldo: saldoDevedorEmAberto(d, parcelas ?? []), cet_aa: d.cet_aa })),
    );
  }, [dividas, parcelas]);
}
