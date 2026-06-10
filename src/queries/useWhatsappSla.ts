import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
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

/** queryFn compartilhada: badge da sidebar e telas ricas usam a MESMA
 *  queryKey → 1 fetch deduplicado pro app inteiro (a view é scan-heavy). */
export async function fetchWhatsappSla(): Promise<WaSlaRow[]> {
  const res = await (waSelectAll('v_whatsapp_sla') as PromiseLike<{ data: unknown; error: { message: string } | null }>);
  if (res.error) throw new Error(res.error.message);
  return (res.data ?? []) as WaSlaRow[];
}

const SLA_QUERY_KEY = ['whatsapp', 'sla'] as const;
const REALTIME_THROTTLE_MS = 3000;

export function useWhatsappSla() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: SLA_QUERY_KEY,
    queryFn: fetchWhatsappSla,
    refetchInterval: 30000, // "tiquetaqueia" o contador (now() na view dá minutos frescos a cada fetch)
    refetchIntervalInBackground: false,
    staleTime: 15000,
  });
  // Realtime: mensagem/conversa nova revalida o SLA — com throttle
  // leading+trailing: o 1º evento invalida na hora; a rajada (blast de
  // template, sync em lote) colapsa numa única revalidação por janela de 3s.
  // Sem o throttle, cada mensagem de QUALQUER conversa re-executava a view
  // scan-heavy inteira, por cliente montado.
  const lastInvalidateRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const invalidate = () => {
      lastInvalidateRef.current = Date.now();
      qc.invalidateQueries({ queryKey: SLA_QUERY_KEY });
    };
    const onEvent = () => {
      const elapsed = Date.now() - lastInvalidateRef.current;
      if (elapsed >= REALTIME_THROTTLE_MS) {
        invalidate();
        return;
      }
      if (timerRef.current !== undefined) return; // trailing já agendado — colapsa
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        invalidate();
      }, REALTIME_THROTTLE_MS - elapsed);
    };
    const ch = supabase.channel('wa-sla')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_messages' }, onEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_conversations' }, onEvent)
      .subscribe();
    return () => {
      // cancel, não flush: componente desmontado não precisa invalidar — o
      // próximo mount refaz a query (staleTime 15s) de qualquer forma.
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
      supabase.removeChannel(ch);
    };
  }, [qc]);
  return q;
}

/**
 * Badge da sidebar: MESMA queryKey do useWhatsappSla → cache compartilhado.
 * Quando uma tela rica (Meu Dia, inbox, supervisão) está montada, o badge não
 * gera NENHUM fetch próprio; sozinho, pola a 60s (React Query usa o menor
 * intervalo entre observers ativos). O `select` deriva só o count do usuário.
 * Sem canal realtime próprio: quando uma tela rica invalida, o cache
 * compartilhado atualiza o badge de graça.
 *
 * Substitui a query antiga ['whatsapp-sla-badge'] que baixava a view
 * scan-heavy INTEIRA em paralelo (key própria, sem compartilhar cache) e
 * filtrava no client.
 */
export function useWhatsappSlaBadge(userId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: SLA_QUERY_KEY,
    queryFn: fetchWhatsappSla,
    enabled: enabled && !!userId,
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    staleTime: 15000,
    select: (rows: WaSlaRow[]) =>
      rows.filter((r) => r.owner_user_id === userId && r.nivel === 'vermelho').length,
  });
}
