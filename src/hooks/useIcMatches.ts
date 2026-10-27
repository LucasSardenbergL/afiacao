import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type IcMatch = {
  id: string;
  empresa_origem: string;
  empresa_destino: string;
  cr_id: string | null;
  cp_id: string | null;
  valor_origem: number | null;
  valor_destino: number | null;
  /** NULL quando não há contrapartida para comparar — nunca 0 (ausente ≠ zero). */
  diff_valor: number | null;
  diff_dias: number | null;
  status:
    | 'auto_matched'
    | 'manual_matched'
    | 'divergencia_valor'
    | 'divergencia_data'
    | 'sem_contrapartida'
    | 'duplicidade_possivel'
    | 'desconsiderado'
    // Venda intragrupo sem cobrança (migration 20261021190000): só o master marca/desfaz — o trigger
    // do banco governa e carimba resolvido_por/resolvido_em.
    | 'intragrupo_sem_cobranca';
  matched_at: string;
  observacao: string | null;
};

const STATUS_IC = [
  'auto_matched', 'manual_matched', 'divergencia_valor', 'divergencia_data',
  'sem_contrapartida', 'duplicidade_possivel', 'desconsiderado', 'intragrupo_sem_cobranca',
] as const satisfies readonly IcMatch['status'][];
const ehStatusIc = (v: string): v is IcMatch['status'] => STATUS_IC.some((s) => s === v);

export function useIcMatches(filterStatus?: IcMatch['status']) {
  return useQuery({
    queryKey: ['fin_ic_matches', filterStatus ?? 'all'],
    queryFn: async (): Promise<IcMatch[]> => {
      // Projeção explícita (não select('*')): a tabela tem colunas de auditoria
      // (resolvido_por/resolvido_em/…) que a UI não usa. Estas são exatamente as
      // do type IcMatch — o retorno tipado garante que nenhum consumidor lê além.
      let q = supabase
        .from('fin_ic_matches')
        .select('id, empresa_origem, empresa_destino, cr_id, cp_id, valor_origem, valor_destino, diff_valor, diff_dias, status, matched_at, observacao')
        .order('matched_at', { ascending: false })
        .limit(500);
      if (filterStatus) q = q.eq('status', filterStatus);
      const { data, error } = await q;
      if (error) throw error;
      // `status` é texto com CHECK: confere o vocabulário em vez de afirmá-lo (fora dele, lança).
      return (data ?? []).map((m) => {
        if (!ehStatusIc(m.status)) throw new Error(`fin_ic_matches: "status" = "${m.status}" fora do vocabulário`);
        return { ...m, status: m.status };
      });
    },
  });
}

export function useResolveIcMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      status: IcMatch['status'];
      observacao?: string;
    }) => {
      const user = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from('fin_ic_matches')
        .update({
          status: input.status,
          observacao: input.observacao ?? null,
          resolvido_por: user.data.user?.id,
          resolvido_em: new Date().toISOString(),
        })
        .eq('id', input.id)
        .select('id');
      if (error) throw error;
      // 0 linhas não é sucesso: a RLS escondeu a linha ou a edge a refez entre a leitura e o clique (o id
      // mudou). Sem isto o toast dizia "Aprovado" sobre uma decisão que não foi gravada.
      if (!data || data.length !== 1) {
        throw new Error('a linha não foi atualizada (sem permissão ou já recalculada) — recarregue a fila');
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fin_ic_matches'] }),
  });
}

export function useReconcileIcNow() {
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke(
        'fin-ic-reconcile',
        { body: {} }
      );
      if (error) throw error;
      return data;
    },
  });
}
