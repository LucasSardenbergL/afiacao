// src/hooks/useEndividamento.ts
// F1 Módulo de Endividamento — camada de dados (react-query).
// As tabelas fin_dividas / fin_divida_parcelas / fin_divida_completude são master-only (RLS). Cliente
// tipado pelo types.ts; o vocabulário de CHECK (company/tipo/cp_inclusion_status) é conferido na borda
// (paraDivida), que LANÇA fora dele.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { TablesInsert } from '@/integrations/supabase/types';
import type { Divida, Parcela, Company } from '@/lib/financeiro/endividamento-types';
import { paraDivida } from '@/lib/financeiro/borda-tabelas';
import { mensagemDeErro } from '@/lib/erro-mensagem';

const STALE = 60_000;

// ─── Queries ─────────────────────────────────────────────────────────────────────

/** Dívidas de uma empresa (select * de fin_dividas, ordenado por credor). */
export function useDividas(company: Company | string) {
  return useQuery({
    queryKey: ['endividamento', company, 'dividas'],
    enabled: Boolean(company),
    staleTime: STALE,
    queryFn: async (): Promise<Divida[]> => {
      const { data, error } = await supabase
        .from('fin_dividas')
        .select('*')
        .eq('company', company)
        .order('credor');
      if (error) throw new Error(error.message);
      return (data ?? []).map(paraDivida);
    },
  });
}

/** Parcelas de um conjunto de dívidas (.in divida_id). Desabilitado sem ids. */
export function useParcelas(dividaIds: string[]) {
  return useQuery({
    queryKey: ['endividamento', 'parcelas', [...dividaIds].sort()],
    enabled: dividaIds.length > 0,
    staleTime: STALE,
    queryFn: async (): Promise<Parcela[]> => {
      const { data, error } = await supabase
        .from('fin_divida_parcelas')
        .select('*')
        .in('divida_id', dividaIds);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });
}

/** Completude do cadastro da empresa. Ausente → { completo: false } (fail-closed money-path). */
export function useCompletude(company: Company | string) {
  return useQuery({
    queryKey: ['endividamento', company, 'completude'],
    enabled: Boolean(company),
    staleTime: STALE,
    queryFn: async (): Promise<{ completo: boolean }> => {
      const { data, error } = await supabase
        .from('fin_divida_completude')
        .select('completo')
        .eq('company', company)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return { completo: data?.completo === true };
    },
  });
}

// ─── Mutations ─────────────────────────────────────────────────────────────────────

function invalidate(qc: ReturnType<typeof useQueryClient>, company: string) {
  qc.invalidateQueries({ queryKey: ['endividamento', company] });
  qc.invalidateQueries({ queryKey: ['endividamento', 'parcelas'] });
}

/** Insert (sem id) ou update (com id) de uma dívida. */
export function useUpsertDivida() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (divida: TablesInsert<'fin_dividas'> & { company: Company }) => {
      const { error } = await supabase
        .from('fin_dividas')
        .upsert({ ...divida, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_data, vars) => {
      invalidate(qc, vars.company);
      toast.success('Dívida salva.');
    },
    onError: (e) => {
      toast.error('Falha ao salvar dívida', {
        description: mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.',
      });
    },
  });
}

/** Exclui a dívida (as parcelas caem por FK cascade no banco). */
export function useDeleteDivida() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; company: Company }) => {
      const { error } = await supabase.from('fin_dividas').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSuccess: (_data, vars) => {
      invalidate(qc, vars.company);
      toast.success('Dívida excluída.');
    },
    onError: (e) => {
      toast.error('Falha ao excluir dívida', {
        description: mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.',
      });
    },
  });
}

/**
 * Substitui todas as parcelas de uma dívida via RPC transacional
 * `fin_divida_replace_parcelas` (delete+insert atômico no servidor — Codex P1:
 * o replace client-side não-atômico podia apagar as parcelas se o insert falhasse).
 */
export function useReplaceParcelas() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      dividaId,
      parcelas,
    }: {
      dividaId: string;
      company: Company;
      parcelas: Array<Omit<Parcela, 'id' | 'divida_id'>>;
    }) => {
      const { error } = await supabase.rpc('fin_divida_replace_parcelas', {
        p_divida_id: dividaId,
        // Parcela é interface (não cabe em Json): remonta o objeto com as MESMAS 7 chaves do tipo.
        p_parcelas: parcelas.map((p) => ({
          numero_parcela: p.numero_parcela,
          data_vencimento: p.data_vencimento,
          valor_amortizacao: p.valor_amortizacao,
          valor_juros: p.valor_juros,
          valor_total: p.valor_total,
          estimado: p.estimado,
          pago: p.pago,
        })),
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_data, vars) => {
      invalidate(qc, vars.company);
    },
    onError: (e) => {
      toast.error('Falha ao salvar parcelas', {
        description: mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.',
      });
    },
  });
}

/** Marca/desmarca o cadastro de endividamento da empresa como completo. */
export function useSetCompletude() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ company, completo }: { company: Company; completo: boolean }) => {
      const { error } = await supabase.from('fin_divida_completude').upsert(
        { company, completo, validado_em: new Date().toISOString() },
        { onConflict: 'company' },
      );
      if (error) throw new Error(error.message);
    },
    onSuccess: (_data, vars) => {
      invalidate(qc, vars.company);
      toast.success(vars.completo ? 'Cadastro marcado como completo.' : 'Cadastro reaberto.');
    },
    onError: (e) => {
      toast.error('Falha ao atualizar completude', {
        description: mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.',
      });
    },
  });
}
