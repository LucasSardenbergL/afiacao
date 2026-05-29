import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface WaConversation {
  id: string; phone_e164: string | null; contact_name: string | null;
  customer_user_id: string | null; assigned_operator_id: string | null;
  status: string; last_inbound_at: string | null; last_message_at: string | null;
}
export interface WaMessage {
  id: string; conversation_id: string; direction: 'in' | 'out'; type: string;
  body: string | null; status: string | null; created_at: string; wa_timestamp: string | null;
}

// Tabelas novas (whatsapp_conversations / whatsapp_messages) ainda não estão no
// types.ts gerado — mesmo padrão de useClientesNaoVinculados.ts:
// cast via `supabase as unknown as { from: (t: string) => PgConvBuilder }`.
type OrderOpts = { ascending: boolean; nullsFirst?: boolean };
interface PgConvBuilder {
  select: (cols: string) => PgConvBuilder;
  order: (col: string, opts: OrderOpts) => PgConvBuilder;
  limit: (n: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  eq: (col: string, val: string) => PgConvBuilder;
  then: PromiseLike<{ data: unknown; error: { message: string } | null }>['then'];
}

function waFrom(table: string) {
  const client = supabase as unknown as { from: (t: string) => PgConvBuilder };
  return client.from(table);
}

export function useWhatsappConversations() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['whatsapp', 'conversations'],
    queryFn: async () => {
      const res = await (waFrom('whatsapp_conversations')
        .select('*')
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(200) as PromiseLike<{ data: unknown; error: { message: string } | null }>);
      if (res.error) throw new Error(res.error.message);
      return (res.data ?? []) as WaConversation[];
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
      const res = await (waFrom('whatsapp_messages')
        .select('*')
        .eq('conversation_id', conversationId!)
        .order('created_at', { ascending: true }) as PromiseLike<{ data: unknown; error: { message: string } | null }>);
      if (res.error) throw new Error(res.error.message);
      return (res.data ?? []) as WaMessage[];
    },
    enabled: !!conversationId,
  });
  useEffect(() => {
    if (!conversationId) return;
    const channel = supabase.channel(`wa-thread-${conversationId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'whatsapp_messages', filter: `conversation_id=eq.${conversationId}` },
        () => qc.invalidateQueries({ queryKey: ['whatsapp', 'thread', conversationId] }))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [conversationId, qc]);
  return q;
}
