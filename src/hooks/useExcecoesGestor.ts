// src/hooks/useExcecoesGestor.ts
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useDataHealth } from '@/hooks/useDataHealth';
import { spBusinessDate } from '@/lib/time/sp-day';
import { montarExcecoes } from '@/lib/gestor/excecoes/montar';
import type {
  ConsoleExcecoes, DecisaoRiscoInput, SaudeCheckInput, TarefaGapInput,
} from '@/lib/gestor/excecoes/types';

interface AiDecisionRow {
  id: string; customer_user_id: string; farmer_id: string | null;
  primary_reason: string | null; confidence: string | null;
  customer_metrics: Record<string, number | null> | null; created_at: string;
}
interface TarefaRow {
  id: string; descricao: string; customer_user_id: string | null;
  assigned_to: string | null; responsavel_efetivo: string | null; effective_due: string;
  status: string; atrasada: boolean; tem_sugestao_pendente: boolean;
}
interface CandidatoRow { id: string; tarefa_id: string; status: string; }
interface ProfileRow { user_id: string; name: string | null; razao_social: string | null; }

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Console de exceções do founder (3 fontes determinísticas). */
export function useExcecoesGestor(): { data: ConsoleExcecoes | null; isLoading: boolean; refetchAll: () => void } {
  const saudeQ = useDataHealth();

  const decisoesQ = useQuery({
    queryKey: ['gestor-excecoes', 'ai-decisions'],
    staleTime: 60_000,
    queryFn: async (): Promise<AiDecisionRow[]> => {
      const { data, error } = await supabase
        .from('ai_decisions')
        .select('id, customer_user_id, farmer_id, primary_reason, confidence, customer_metrics, created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as AiDecisionRow[];
    },
  });

  const tarefasQ = useQuery({
    queryKey: ['gestor-excecoes', 'tarefas-gap'],
    staleTime: 60_000,
    queryFn: async (): Promise<{ tarefas: TarefaRow[]; candByTarefa: Map<string, string> }> => {
      // v_tarefas_estado: master lê team-wide (RLS reusa pode_ver_carteira_completa).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sel = (supabase.from('v_tarefas_estado' as never) as any)
        .select('id, descricao, customer_user_id, assigned_to, responsavel_efetivo, effective_due, status, atrasada, tem_sugestao_pendente')
        .eq('status', 'aberta').eq('atrasada', true).eq('tem_sugestao_pendente', true);
      const { data, error } = await sel;
      if (error) throw error;
      const tarefas = (data ?? []) as TarefaRow[];
      const ids = tarefas.map(t => t.id);
      const candByTarefa = new Map<string, string>();
      if (ids.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const candSel = (supabase.from('tarefa_satisfacao_candidatos' as never) as any)
          .select('id, tarefa_id, status').in('tarefa_id', ids).eq('status', 'pending');
        const { data: cand, error: cErr } = await candSel;
        if (cErr) throw cErr;
        for (const c of (cand ?? []) as CandidatoRow[]) {
          if (!candByTarefa.has(c.tarefa_id)) candByTarefa.set(c.tarefa_id, c.id);
        }
      }
      return { tarefas, candByTarefa };
    },
  });

  const profilesQ = useQuery({
    queryKey: ['gestor-excecoes', 'profiles', (decisoesQ.data ?? []).length, (tarefasQ.data?.tarefas ?? []).length],
    enabled: decisoesQ.isSuccess && tarefasQ.isSuccess,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, string>> => {
      const ids = new Set<string>();
      for (const d of decisoesQ.data ?? []) { if (d.customer_user_id) ids.add(d.customer_user_id); if (d.farmer_id) ids.add(d.farmer_id); }
      for (const t of tarefasQ.data?.tarefas ?? []) { if (t.responsavel_efetivo) ids.add(t.responsavel_efetivo); }
      const arr = [...ids];
      const nameByUser = new Map<string, string>();
      for (let i = 0; i < arr.length; i += 200) {
        const { data, error } = await supabase.from('profiles').select('user_id, name, razao_social').in('user_id', arr.slice(i, i + 200));
        if (error) throw error;
        for (const p of (data ?? []) as ProfileRow[]) nameByUser.set(p.user_id, p.razao_social ?? p.name ?? '');
      }
      return nameByUser;
    },
  });

  const isLoading = saudeQ.isLoading || decisoesQ.isLoading || tarefasQ.isLoading;

  const data = useMemo<ConsoleExcecoes | null>(() => {
    if (isLoading) return null;
    const nameBy = profilesQ.data ?? new Map<string, string>();
    const nome = (id: string | null): string | null => (id ? (nameBy.get(id) || null) : null);

    const decisoesRows = decisoesQ.data ?? [];
    const decisoes: DecisaoRiscoInput[] = decisoesRows.map(d => ({
      id: d.id,
      clienteUserId: d.customer_user_id,
      clienteNome: nome(d.customer_user_id),
      donoNome: nome(d.farmer_id),
      primaryReason: d.primary_reason ?? '',
      confidence: d.confidence ?? '',
      atrasoRelativo: num(d.customer_metrics?.atraso_relativo),
      faturamento90d: num(d.customer_metrics?.faturamento_90d),
      faturamentoPrev90d: num(d.customer_metrics?.faturamento_prev_90d),
    }));
    const decisoesMaxCreatedAtIso = decisoesRows.length > 0 ? decisoesRows[0].created_at : null;

    const saude: SaudeCheckInput[] = (saudeQ.data ?? []).map(s => ({
      source: s.source, domain: s.domain, status: s.status, severity: s.severity, message: s.message, ageSeconds: s.age_seconds,
    }));

    const candBy = tarefasQ.data?.candByTarefa ?? new Map<string, string>();
    const tarefas: TarefaGapInput[] = (tarefasQ.data?.tarefas ?? []).map(t => ({
      tarefaId: t.id,
      descricao: t.descricao,
      clienteUserId: t.customer_user_id,
      donoNome: nome(t.responsavel_efetivo),
      effectiveDue: t.effective_due,
      candidatoId: candBy.get(t.id) ?? null,
    }));

    return montarExcecoes({
      decisoes, decisoesMaxCreatedAtIso, saude, tarefas,
      hojeSp: spBusinessDate(new Date()),
      agoraIso: new Date().toISOString(),
    });
  }, [isLoading, saudeQ.data, decisoesQ.data, tarefasQ.data, profilesQ.data]);

  const refetchAll = () => { saudeQ.refetch(); decisoesQ.refetch(); tarefasQ.refetch(); };
  return { data, isLoading, refetchAll };
}
