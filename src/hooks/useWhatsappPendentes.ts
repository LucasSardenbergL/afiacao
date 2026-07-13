// Fonte "WhatsApp pendente" da fila do dia (PR-2 do Canal WhatsApp).
// Reescrito sobre a RPC get_whatsapp_pendentes: pendência decidida no SQL com
// last_outbound_at REAL (trigger 1-writer) — mata o falso-negativo do v1
// (cap 200 do inbox + proxy last_message_at, Codex P1). SECURITY INVOKER:
// a RLS staff aplica; conversa com dono só aparece pro dono.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { mapPendenteRows, type WaPendente } from '@/lib/fila/adapters/whatsappPendente';

export function useWhatsappPendentes(): {
  data: WaPendente[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
} {
  const q = useQuery({
    queryKey: ['whatsapp', 'pendentes'],
    queryFn: async () => {
      // RPC nova ainda fora do types.ts gerado — mesmo padrão de useDataHealth.ts
      const { data, error } = await supabase.rpc('get_whatsapp_pendentes' as never);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown[];
    },
  });

  const data = useMemo(() => mapPendenteRows(q.data ?? [], Date.now()), [q.data]);

  return { data, isLoading: q.isLoading, isError: q.isError, error: q.error, refetch: () => void q.refetch() };
}
