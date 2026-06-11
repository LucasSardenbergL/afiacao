// src/hooks/useMelhorias.ts
// Queries/mutations do canal de Melhorias. Captação independe da IA:
// criarMelhoria grava item+mensagem ANTES do invoke; invoke falho = item pendente na fila.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { useAuth } from '@/contexts/AuthContext';
import type { MelhoriaItem, MelhoriaMensagem, MelhoriaStatus } from '@/lib/melhorias/types';
import type { Database } from '@/integrations/supabase/types';

type MelhoriaItemUpdate = Database['public']['Tables']['melhoria_itens']['Update'];

const ITENS_KEY = ['melhorias', 'meus'] as const;
const GESTAO_KEY = ['melhorias', 'gestao'] as const;
const threadKey = (itemId: string) => ['melhorias', 'thread', itemId] as const;

async function invocarTriagem(itemId: string): Promise<{ ok: boolean; fallback?: boolean }> {
  const { data, error } = await supabase.functions.invoke('melhoria-triagem', { body: { item_id: itemId } });
  if (error) return { ok: false, fallback: true };
  return (data as { ok: boolean; fallback?: boolean }) ?? { ok: false, fallback: true };
}

/** Itens do PRÓPRIO usuário. Filtro explícito por autor — a RLS sozinha não basta:
 *  o master vê tudo por RLS, e sem o .eq() a página "Minhas melhorias" mostraria
 *  itens alheios como dele (Important #1 do review final). */
export function useMeusMelhoriaItens() {
  const { user } = useAuth();
  return useQuery({
    queryKey: [...ITENS_KEY, user?.id ?? 'anon'],
    enabled: !!user?.id,
    queryFn: async (): Promise<MelhoriaItem[]> => {
      const { data, error } = await supabase
        .from('melhoria_itens').select('*')
        .eq('autor_user_id', user!.id)
        .order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      return (data ?? []) as MelhoriaItem[];
    },
  });
}

export function useMelhoriaThread(itemId: string | null) {
  return useQuery({
    queryKey: threadKey(itemId ?? 'none'),
    enabled: !!itemId,
    queryFn: async (): Promise<MelhoriaMensagem[]> => {
      const { data, error } = await supabase
        .from('melhoria_mensagens').select('*')
        .eq('item_id', itemId!).order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as MelhoriaMensagem[];
    },
  });
}

interface CriarMelhoriaInput {
  conteudo: string;
  empresa: string;
  rotaOrigem: string;
  autorUserId: string;
}

/** Cria item + mensagem inicial e dispara a triagem. A escrita NUNCA depende da IA. */
export function useCriarMelhoria() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CriarMelhoriaInput) => {
      const { data: item, error: itemErr } = await supabase
        .from('melhoria_itens')
        .insert({ autor_user_id: input.autorUserId, empresa: input.empresa, rota_origem: input.rotaOrigem })
        .select('*').single();
      if (itemErr) throw itemErr;

      const { error: msgErr } = await supabase.from('melhoria_mensagens').insert({
        item_id: item.id, autor_user_id: input.autorUserId, papel: 'funcionario', conteudo: input.conteudo.trim(),
      });
      if (msgErr) throw msgErr;

      track('melhoria.criada', { empresa: input.empresa, rota: input.rotaOrigem });
      const triagem = await invocarTriagem(item.id);
      track('melhoria.ia_respondeu', { ok: triagem.ok });
      return { item: item as MelhoriaItem, triagemOk: triagem.ok };
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['melhorias'] });
    },
  });
}

export function useEnviarReplica(itemId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ conteudo, autorUserId }: { conteudo: string; autorUserId: string }) => {
      if (!itemId) throw new Error('Item indefinido');
      const { error } = await supabase.from('melhoria_mensagens').insert({
        item_id: itemId, autor_user_id: autorUserId, papel: 'funcionario', conteudo: conteudo.trim(),
      });
      if (error) throw error;
      track('melhoria.replica', {});
      return invocarTriagem(itemId);
    },
    onSettled: () => {
      if (itemId) qc.invalidateQueries({ queryKey: threadKey(itemId) });
      qc.invalidateQueries({ queryKey: ['melhorias'] });
    },
  });
}

/** Fila completa (master; RLS barra os demais). Filtros aplicados client-side sobre 200 itens. */
export function useGestaoMelhorias(enabled: boolean) {
  return useQuery({
    queryKey: GESTAO_KEY,
    enabled,
    queryFn: async (): Promise<MelhoriaItem[]> => {
      const { data, error } = await supabase
        .from('melhoria_itens').select('*')
        .order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      return (data ?? []) as MelhoriaItem[];
    },
  });
}

export function useAlterarStatusMelhoria() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, status, resposta }: { itemId: string; status: MelhoriaStatus; resposta?: string }) => {
      const patch: MelhoriaItemUpdate = { status };
      if (resposta !== undefined) patch.resposta_founder = resposta.trim() || null;
      patch.resolvido_em = status === 'resolvido' || status === 'descartado' ? new Date().toISOString() : null;
      const { error } = await supabase.from('melhoria_itens').update(patch).eq('id', itemId);
      if (error) throw error;
      track('melhoria.status_alterado', { status });
    },
    onError: () => toast.error('Falha ao atualizar o item — tente de novo.'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['melhorias'] }),
  });
}

export function useRetriarMelhoria() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => invocarTriagem(itemId),
    onSettled: () => qc.invalidateQueries({ queryKey: ['melhorias'] }),
  });
}

/** Badge master: itens abertos. Gate no caller (enabled) — só pollar quando master real. */
export function useMelhoriasBadge(enabled: boolean) {
  return useQuery({
    queryKey: ['melhorias', 'badge-abertos'],
    enabled,
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    staleTime: 30000,
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabase
        .from('melhoria_itens').select('id', { count: 'exact', head: true })
        .eq('status', 'aberto');
      if (error) return 0;
      return count ?? 0;
    },
  });
}
