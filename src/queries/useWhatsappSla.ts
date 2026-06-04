import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { SlaNivel } from '@/lib/whatsapp/sla-format';

export interface WaSlaRow {
  conversation_id: string;
  customer_user_id: string | null;
  phone_e164: string | null;
  contact_name: string | null;
  owner_user_id: string | null;
  aguardando_desde: string;
  minutos_uteis_aguardando: number;
  nivel: SlaNivel;
}

// v_whatsapp_sla não está no types.ts gerado — mesmo cast de useWhatsappInbox.ts.
function waSelectAll(view: string) {
  const client = supabase as unknown as {
    from: (t: string) => { select: (c: string) => PromiseLike<{ data: unknown; error: { message: string } | null }> };
  };
  return client.from(view).select('*');
}

export function useWhatsappSla() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['whatsapp', 'sla'],
    queryFn: async () => {
      const res = await (waSelectAll('v_whatsapp_sla') as PromiseLike<{ data: unknown; error: { message: string } | null }>);
      if (res.error) throw new Error(res.error.message);
      return (res.data ?? []) as WaSlaRow[];
    },
    refetchInterval: 30000, // "tiquetaqueia" o contador (now() na view dá minutos frescos a cada fetch)
    staleTime: 15000,
  });
  // Realtime: qualquer mensagem/conversa nova revalida o SLA na hora.
  useEffect(() => {
    const ch = supabase.channel('wa-sla')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_messages' },
        () => qc.invalidateQueries({ queryKey: ['whatsapp', 'sla'] }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_conversations' },
        () => qc.invalidateQueries({ queryKey: ['whatsapp', 'sla'] }))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc]);
  return q;
}
