/**
 * Hooks da Fase 2 das Tarefas (enforcement: recorrência + trava de comprovação).
 *
 * Padrão: mesmo estilo de `useTarefas.ts`:
 *   - supabase.from('tabela' as never) as any — tabelas ainda não estão nos tipos gerados
 *   - supabase.rpc('fn' as never, {...} as never) — RPCs idem
 *   - toast de sonner + track de analytics + invalidação de query
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import type { TarefaTemplate, TarefaInstancia } from '@/lib/tarefas/templates-types';

// ---------------------------------------------------------------------------
// Helpers de acesso (casts necessários até os tipos gerados serem regenerados)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const selView = () => (supabase.from('v_tarefas_estado' as never) as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const selTemplates = () => (supabase.from('tarefa_templates' as never) as any);

// Chaves de query compartilhadas com useTarefas para invalidação cruzada
const QUERY_KEYS = {
  templates: 'tarefa-templates',
  minhasRecorrentes: 'tarefas-recorrentes-hoje',
  provasAuditar: 'tarefas-provas-auditar',
  // Chaves da Fase 1 que invalidamos quando concluímos / auditamos
  minhasTarefas: 'minhas-tarefas',
  tarefasQueCriei: 'tarefas-que-criei',
  badgeCount: 'tarefas-badge-count',
} as const;

// ---------------------------------------------------------------------------
// useTemplates — lista templates (RLS já filtra: gestor vê todos, operador vê os seus)
// ---------------------------------------------------------------------------

export function useTemplates() {
  const { user } = useAuth();
  return useQuery({
    queryKey: [QUERY_KEYS.templates, user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<TarefaTemplate[]> => {
      const { data, error } = await selTemplates()
        .select('*')
        .order('ativo', { ascending: false })
        .order('descricao', { ascending: true });
      if (error) throw error;
      return (data ?? []) as TarefaTemplate[];
    },
  });
}

// ---------------------------------------------------------------------------
// useTemplateMutations — CRUD de templates (gestor/master)
// ---------------------------------------------------------------------------

export function useTemplateMutations() {
  const qc = useQueryClient();
  const { user } = useAuth();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [QUERY_KEYS.templates] });
    qc.invalidateQueries({ queryKey: [QUERY_KEYS.minhasRecorrentes] });
  };

  const criarTemplate = async (row: Omit<TarefaTemplate, 'id' | 'created_at' | 'updated_at'>) => {
    const { data, error } = await selTemplates()
      .insert({ ...row, created_by: user!.id } as never)
      .select('id')
      .single();
    if (error) {
      toast.error('Erro ao criar template', { description: error.message });
      throw error;
    }
    track('tarefas.template_criado', { area: row.area, cadencia: row.cadencia });
    toast.success('Template criado');
    invalidate();
    return (data as { id: string }).id;
  };

  const editarTemplate = async (id: string, patch: Partial<TarefaTemplate>) => {
    const { error } = await selTemplates()
      .update({ ...patch, updated_at: new Date().toISOString() } as never)
      .eq('id', id);
    if (error) {
      toast.error('Erro ao editar template', { description: error.message });
      throw error;
    }
    track('tarefas.template_editado', {});
    toast.success('Template atualizado');
    invalidate();
  };

  const toggleTemplateAtivo = async (id: string, ativo: boolean) => {
    const { error } = await selTemplates()
      .update({ ativo, updated_at: new Date().toISOString() } as never)
      .eq('id', id);
    if (error) {
      toast.error(`Erro ao ${ativo ? 'ativar' : 'desativar'} template`, { description: error.message });
      throw error;
    }
    track('tarefas.template_toggle', { ativo });
    toast.success(ativo ? 'Template ativado' : 'Template desativado');
    invalidate();
  };

  return { criarTemplate, editarTemplate, toggleTemplateAtivo };
}

// ---------------------------------------------------------------------------
// useMinhasRecorrentesHoje — instâncias do operador logado (or impersonated)
// Filtra: template_id not null + status aberta + responsavel_efetivo = uid
// ---------------------------------------------------------------------------

export function useMinhasRecorrentesHoje() {
  const { user } = useAuth();
  const { isImpersonating, effectiveUserId } = useImpersonation();
  const targetId = isImpersonating && effectiveUserId ? effectiveUserId : (user?.id ?? null);

  return useQuery({
    queryKey: [QUERY_KEYS.minhasRecorrentes, isImpersonating ? `as:${effectiveUserId}` : user?.id],
    enabled: !!targetId,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    queryFn: async (): Promise<TarefaInstancia[]> => {
      const { data, error } = await selView()
        .select('*')
        .eq('status', 'aberta')
        .not('template_id', 'is', null)
        .order('atrasada', { ascending: false })
        .order('effective_due', { ascending: true });
      if (error) throw error;
      // Filtro client-side de responsavel_efetivo (mesma lógica de useMinhasTarefas)
      return ((data ?? []) as TarefaInstancia[]).filter(
        (t) => t.responsavel_efetivo === targetId,
      );
    },
  });
}

// ---------------------------------------------------------------------------
// concluirComComprovacao — chama o RPC com url + leitura
// ---------------------------------------------------------------------------

export function useConcluirComComprovacao() {
  const qc = useQueryClient();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [QUERY_KEYS.minhasRecorrentes] });
    qc.invalidateQueries({ queryKey: [QUERY_KEYS.provasAuditar] });
    qc.invalidateQueries({ queryKey: [QUERY_KEYS.minhasTarefas] });
    qc.invalidateQueries({ queryKey: [QUERY_KEYS.tarefasQueCriei] });
    qc.invalidateQueries({ queryKey: [QUERY_KEYS.badgeCount] });
  };

  const concluirComComprovacao = async (
    tarefaId: string,
    url: string | null,
    leitura: number | null,
  ) => {
    const { error } = await supabase.rpc('concluir_com_comprovacao' as never, {
      p_tarefa_id: tarefaId,
      p_url: url,
      p_leitura: leitura,
    } as never);
    if (error) {
      toast.error('Erro ao concluir tarefa', { description: error.message });
      throw error;
    }
    track('tarefas.concluida_comprovacao', { com_leitura: leitura !== null, com_foto: url !== null });
    toast.success('Tarefa concluída');
    invalidate();
  };

  return { concluirComComprovacao };
}

// ---------------------------------------------------------------------------
// useProvasParaAuditar — tarefas aguardando auditoria (gestor/master)
// ---------------------------------------------------------------------------

export function useProvasParaAuditar() {
  const { user } = useAuth();
  return useQuery({
    queryKey: [QUERY_KEYS.provasAuditar, user?.id],
    enabled: !!user,
    staleTime: 30_000,
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
    queryFn: async (): Promise<TarefaInstancia[]> => {
      const { data, error } = await selView()
        .select('*')
        .eq('requer_auditoria', true)
        .order('comprovacao_em', { ascending: true });
      if (error) throw error;
      return (data ?? []) as TarefaInstancia[];
    },
  });
}

// ---------------------------------------------------------------------------
// useAuditarTarefa — aprovar / reprovar prova (gestor/master)
// ---------------------------------------------------------------------------

export function useAuditarTarefa() {
  const qc = useQueryClient();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [QUERY_KEYS.provasAuditar] });
    qc.invalidateQueries({ queryKey: [QUERY_KEYS.tarefasQueCriei] });
    qc.invalidateQueries({ queryKey: [QUERY_KEYS.badgeCount] });
  };

  const auditarTarefa = async (tarefaId: string, aprovar: boolean, motivo: string) => {
    const { error } = await supabase.rpc('auditar_tarefa' as never, {
      p_tarefa_id: tarefaId,
      p_aprovar: aprovar,
      p_motivo: motivo,
    } as never);
    if (error) {
      toast.error('Erro ao auditar tarefa', { description: error.message });
      throw error;
    }
    track('tarefas.auditada', { aprovar });
    toast.success(aprovar ? 'Prova aprovada' : 'Prova reprovada — tarefa reaberta');
    invalidate();
  };

  return { auditarTarefa };
}
