import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';
import { toast } from 'sonner';
import {
  appendRealtimeMessage,
  mergeThreadWindow,
  prependOlderMessages,
  THREAD_LIMIT,
} from '@/lib/whatsapp/thread-cache';

interface WaConversation {
  id: string; phone_e164: string | null; contact_name: string | null;
  customer_user_id: string | null; assigned_operator_id: string | null;
  status: string; last_inbound_at: string | null; last_message_at: string | null;
}
export interface WaMessage {
  id: string; conversation_id: string; direction: 'in' | 'out'; type: string;
  body: string | null; status: string | null; created_at: string; wa_timestamp: string | null;
}

// whatsapp_conversations / whatsapp_messages estão no types.ts. `direction` é texto na tabela
// (CHECK 'in'/'out' na prod): a mensagem passa por `paraWaMessage`, que lança fora do vocabulário.
type LinhaMensagem = Database['public']['Tables']['whatsapp_messages']['Row'];

function paraWaMessage(l: LinhaMensagem): WaMessage {
  if (l.direction !== 'in' && l.direction !== 'out') {
    throw new Error(`whatsapp_messages: "direction" = "${l.direction}" fora do vocabulário`);
  }
  return {
    id: l.id, conversation_id: l.conversation_id, direction: l.direction, type: l.type,
    body: l.body, status: l.status, created_at: l.created_at, wa_timestamp: l.wa_timestamp,
  };
}

export function useWhatsappConversations() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['whatsapp', 'conversations'],
    queryFn: async () => {
      const res = await supabase
        .from('whatsapp_conversations')
        .select('*')
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(200);
      if (res.error) throw new Error(res.error.message);
      const conversas: WaConversation[] = res.data ?? [];
      return conversas;
    },
  });
  useEffect(() => {
    const channel = supabase.channel('wa-conversations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_conversations' },
        () => qc.invalidateQueries({ queryKey: ['whatsapp', 'conversations'] }))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [qc]);
  return q;
}

export function useWhatsappThread(conversationId: string | undefined) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['whatsapp', 'thread', conversationId],
    queryFn: async () => {
      // DESC + limit + reverse: as ÚLTIMAS 100 mensagens. A versão sem limit
      // em ordem asc estourava o cap de 1000 do PostgREST ficando com as 1000
      // mais ANTIGAS — em conversa longa, as mensagens novas SUMIAM da tela.
      const res = await supabase
        .from('whatsapp_messages')
        .select('*')
        .eq('conversation_id', conversationId!)
        .order('created_at', { ascending: false })
        .limit(THREAD_LIMIT);
      if (res.error) throw new Error(res.error.message);
      const janela = (res.data ?? []).map(paraWaMessage).reverse();
      // Merge com o cache anterior (helper testado): o refetch baixa só a
      // janela recente, mas o cache pode ter HISTÓRICO carregado via
      // "mensagens anteriores" — sem o merge, o invalidate de reconciliação
      // do envio descartaria o histórico e a tela pularia pras últimas 100.
      return mergeThreadWindow(
        qc.getQueryData<WaMessage[]>(['whatsapp', 'thread', conversationId]),
        janela,
      );
    },
    enabled: !!conversationId,
  });
  useEffect(() => {
    if (!conversationId) return;
    const channel = supabase.channel(`wa-thread-${conversationId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'whatsapp_messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          // Append INCREMENTAL (helper testado): era invalidate → re-baixava a
          // conversa inteira a cada mensagem. Dedupe por id; OUT reconcilia a
          // otimista do próprio envio (ver thread-cache.ts).
          qc.setQueryData<WaMessage[]>(
            ['whatsapp', 'thread', conversationId],
            (old) => appendRealtimeMessage(old, payload.new as WaMessage),
          );
        })
      .subscribe((status) => {
        // Fecha a janela SELECT→SUBSCRIBED e cobre RECONEXÕES (retroativo
        // Codex): INSERTs antes do canal assinar (ou durante uma queda) não
        // são retroentregues pelo realtime — sem este refetch, a mensagem
        // ficava ausente até a próxima invalidação. O mergeThreadWindow da
        // queryFn preserva o histórico carregado (sem flicker).
        if (status === 'SUBSCRIBED') {
          qc.invalidateQueries({ queryKey: ['whatsapp', 'thread', conversationId] });
        }
      });
    return () => { supabase.removeChannel(channel); };
  }, [conversationId, qc]);
  return q;
}

/**
 * "Carregar mensagens anteriores": busca a página seguinte do histórico
 * (mensagens mais antigas que a primeira do cache) e faz PREPEND no cache da
 * thread — fecha a regressão de produto da janela de 100 (conversas longas
 * tinham o histórico antigo inacessível na UI).
 *
 * Cursor por `.lte(created_at da mais antiga)`: o `lte` (não `lt`) garante que
 * irmãs com o MESMO timestamp do cursor não se percam; as duplicatas
 * re-baixadas morrem no dedupe do prependOlderMessages. Fim do histórico =
 * página crua menor que o limit OU zero mensagens novas após dedupe (guard
 * anti-loop). Estado é local do hook — monte com key por conversa.
 */
export function useLoadOlderWhatsappMessages(conversationId: string | undefined) {
  const qc = useQueryClient();
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const loadOlder = useCallback(async () => {
    if (!conversationId || isLoadingOlder || exhausted) return;
    const threadKey = ['whatsapp', 'thread', conversationId];
    // Lê o cache no CLIQUE (não closure): a mais antiga pode ter mudado após
    // um prepend anterior. old[0] nunca é otimista (otimista é append no fim).
    const atual = qc.getQueryData<WaMessage[]>(threadKey);
    const maisAntiga = atual?.[0];
    if (!maisAntiga) return;
    setIsLoadingOlder(true);
    try {
      const res = await supabase
        .from('whatsapp_messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .lte('created_at', maisAntiga.created_at)
        .order('created_at', { ascending: false })
        .limit(THREAD_LIMIT);
      if (res.error) throw new Error(res.error.message);
      const pagina = (res.data ?? []).map(paraWaMessage).reverse();
      let added = 0;
      qc.setQueryData<WaMessage[]>(threadKey, (old) => {
        const r = prependOlderMessages(old, pagina);
        added = r.added;
        return r.next;
      });
      if (pagina.length < THREAD_LIMIT || added === 0) setExhausted(true);
    } catch {
      toast.error('Falha ao carregar mensagens anteriores.');
    } finally {
      setIsLoadingOlder(false);
    }
  }, [conversationId, isLoadingOlder, exhausted, qc]);

  return { loadOlder, isLoadingOlder, exhausted };
}
