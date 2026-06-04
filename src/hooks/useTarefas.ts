import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import type { TarefaEstado } from '@/lib/tarefas/types';

// As tabelas/view de tarefas ainda não estão nos tipos gerados do Supabase
// (migration aplicada manualmente via Lovable). Cast `as never`/`as any` é o
// padrão do repo (ver FarmerCalls.tsx / useCallLog.ts) até os tipos regenerarem.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sel = () => (supabase.from('v_tarefas_estado' as never) as any);

/** Tarefas da vendedora logada (do responsável efetivo: assigned_to OU cobertura). A RLS já filtra. */
export function useMinhasTarefas() {
  const { user } = useAuth();
  const { isImpersonating, effectiveUserId } = useImpersonation();
  // Impersonation-aware: no "Ver como", o master lê (RLS permite) e filtramos pro alvo.
  const targetId = isImpersonating && effectiveUserId ? effectiveUserId : (user?.id ?? null);
  return useQuery({
    queryKey: ['minhas-tarefas', isImpersonating ? `as:${effectiveUserId}` : user?.id],
    enabled: !!targetId,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    queryFn: async (): Promise<TarefaEstado[]> => {
      const { data, error } = await sel()
        .select('*')
        .eq('status', 'aberta')
        .order('atrasada', { ascending: false })
        .order('effective_due', { ascending: true });
      if (error) throw error;
      return ((data ?? []) as TarefaEstado[]).filter(t => t.responsavel_efetivo === targetId);
    },
  });
}

/** Lista do founder: tarefas que ELE criou + status. */
export function useTarefasQueCriei(filtroStatus: 'todas' | 'aberta' | 'concluida' | 'cancelada' = 'todas') {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['tarefas-que-criei', user?.id, filtroStatus],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async (): Promise<TarefaEstado[]> => {
      let q = sel().select('*').eq('created_by', user!.id)
        .order('effective_due', { ascending: true });
      if (filtroStatus !== 'todas') q = q.eq('status', filtroStatus);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as TarefaEstado[];
    },
  });
}

/** Sugestões pendentes (candidatos) das tarefas visíveis à vendedora. */
export function useTarefaSugestoes(tarefaIds: string[]) {
  return useQuery({
    queryKey: ['tarefa-sugestoes', tarefaIds.slice().sort()],
    enabled: tarefaIds.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cand = () => (supabase.from('tarefa_satisfacao_candidatos' as never) as any);
      const { data, error } = await cand()
        .select('*').in('tarefa_id', tarefaIds).eq('status', 'pending');
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useTarefaMutations() {
  const qc = useQueryClient();
  const { user } = useAuth();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tarefas = () => (supabase.from('tarefas' as never) as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eventos = () => (supabase.from('tarefa_eventos' as never) as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidatos = () => (supabase.from('tarefa_satisfacao_candidatos' as never) as any);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['minhas-tarefas'] });
    qc.invalidateQueries({ queryKey: ['tarefas-que-criei'] });
    qc.invalidateQueries({ queryKey: ['tarefa-sugestoes'] });
    qc.invalidateQueries({ queryKey: ['tarefas-badge-count'] });
  };

  /** Cria N tarefas (cada linha carrega seu próprio cliente). Opcional: auditoria da origem por voz. */
  const criarTarefas = async (
    linhas: Array<Record<string, unknown>>,
    auditVoz?: { transcricao: string; evidencias: string[] },
  ): Promise<{ ids: string[] }> => {
    const rows = linhas.map((l) => ({ ...l, created_by: user!.id }));
    const { data, error } = await tarefas().insert(rows as never).select('id');
    if (error) { toast.error('Erro ao criar tarefa', { description: error.message }); throw error; }
    const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    track('tarefas.created', { qtd: rows.length, origem: auditVoz ? 'voz' : 'form' });
    if (auditVoz && ids.length > 0) {
      // best-effort: a auditoria NUNCA derruba a criação (as tarefas já foram inseridas acima).
      // ordem do insert preservada pela representação do PostgREST → ids[i] ↔ evidencias[i].
      try {
        const eventos_rows = ids.map((id, i) => ({
          tarefa_id: id, tipo_evento: 'criada_por_voz', ator: user!.id,
          payload: { transcricao: auditVoz.transcricao, evidence_text: auditVoz.evidencias[i] ?? null },
        }));
        await eventos().insert(eventos_rows as never);
      } catch { /* best-effort — auditoria é nice-to-have, não bloqueia o fluxo */ }
    }
    toast.success(rows.length > 1 ? `${rows.length} tarefas criadas` : 'Tarefa criada');
    invalidate();
    return { ids };
  };

  /** Conclusão manual (inclui o botão WhatsApp, que passa origem='whatsapp'). */
  const concluir = async (id: string, origem: 'manual' | 'whatsapp', nota?: string) => {
    const { error } = await tarefas()
      .update({ status: 'concluida', concluida_em: new Date().toISOString(),
                concluida_por: user!.id, conclusao_origem: origem, nota_conclusao: nota ?? null,
                updated_at: new Date().toISOString() } as never)
      .eq('id', id);
    if (error) { toast.error('Erro ao concluir'); throw error; }
    await eventos().insert(
      { tarefa_id: id, tipo_evento: origem === 'whatsapp' ? 'concluida_whatsapp' : 'concluida_manual',
        ator: user!.id } as never);
    track('tarefas.completed', { origem });
    toast.success('Tarefa concluída');
    invalidate();
  };

  /** Confirma/rejeita uma sugestão (1 toque). accepted → conclui a tarefa. */
  const resolverSugestao = async (candidatoId: string, tarefaId: string, aceitar: boolean) => {
    const { error } = await candidatos()
      .update({ status: aceitar ? 'accepted' : 'rejected', resolved_at: new Date().toISOString(),
                resolved_by: user!.id } as never).eq('id', candidatoId);
    if (error) { toast.error('Erro ao responder sugestão'); throw error; }
    if (aceitar) {
      await tarefas().update(
        { status: 'concluida', concluida_em: new Date().toISOString(), concluida_por: user!.id,
          conclusao_origem: 'sugestao_confirmada', updated_at: new Date().toISOString() } as never)
        .eq('id', tarefaId);
      await eventos().insert(
        { tarefa_id: tarefaId, tipo_evento: 'sugestao_confirmada', ator: user!.id } as never);
    } else {
      await eventos().insert(
        { tarefa_id: tarefaId, tipo_evento: 'sugestao_rejeitada', ator: user!.id } as never);
    }
    track('tarefas.suggestion_resolved', { aceitar });
    toast.success(aceitar ? 'Confirmada' : 'Ok, segue aberta');
    invalidate();
  };

  /** Adiar com motivo (snooze). */
  const adiar = async (id: string, novaData: string, motivo: string) => {
    const { error } = await tarefas()
      .update({ adiada_para: novaData, motivo_adiamento: motivo, updated_at: new Date().toISOString() } as never)
      .eq('id', id);
    if (error) { toast.error('Erro ao adiar'); throw error; }
    await eventos().insert(
      { tarefa_id: id, tipo_evento: 'adiada', ator: user!.id,
        payload: { adiada_para: novaData, motivo } } as never);
    track('tarefas.snoozed', {});
    toast.success('Tarefa adiada');
    invalidate();
  };

  /** Cancelar (founder/gestor) com motivo. */
  const cancelar = async (id: string, motivo: string) => {
    const { error } = await tarefas()
      .update({ status: 'cancelada', updated_at: new Date().toISOString() } as never).eq('id', id);
    if (error) { toast.error('Erro ao cancelar'); throw error; }
    await eventos().insert(
      { tarefa_id: id, tipo_evento: 'cancelada', ator: user!.id, payload: { motivo } } as never);
    track('tarefas.cancelled', {});
    toast.success('Tarefa cancelada');
    invalidate();
  };

  return { criarTarefas, concluir, resolverSugestao, adiar, cancelar };
}
