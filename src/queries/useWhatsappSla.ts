import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { createLeadingTrailingThrottle } from '@/lib/leading-trailing-throttle';
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
  // leading+trailing (helper testado): o 1º evento invalida na hora; a rajada
  // (blast de template, sync em lote) colapsa numa revalidação por janela de
  // 3s. Sem o throttle, cada mensagem de QUALQUER conversa re-executava a
  // view scan-heavy inteira, por cliente montado.
  //
  // ⚠️ Limitação PRÉ-EXISTENTE (achada na revisão deste PR, não introduzida
  // por ele): o supabase-js REUSA a instância de canal pelo topic 'wa-sla' —
  // quando DUAS instâncias deste hook montam juntas (ex.: Meu Dia monta
  // SlaCardMeuDia + useCriticaFila), o segundo subscribe() é no-op e o match
  // de bindings por índice pode derrubar o canal inteiro (CHANNEL_ERROR
  // silencioso). O realtime do SLA nessas telas fica por conta do poll de
  // 30s. Fix de verdade (canal singleton com refcount) está no mapa da
  // auditoria de 2026-06-09 — Onda 3, junto do trabalho de WhatsApp.
  useEffect(() => {
    const throttle = createLeadingTrailingThrottle(() => {
      qc.invalidateQueries({ queryKey: SLA_QUERY_KEY });
    }, REALTIME_THROTTLE_MS);
    const ch = supabase.channel('wa-sla')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_messages' }, throttle.fire)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_conversations' }, throttle.fire)
      .subscribe();
    return () => {
      // cancel, não flush: componente desmontado não precisa invalidar — o
      // próximo mount refaz a query (staleTime 15s) de qualquer forma.
      throttle.cancel();
      supabase.removeChannel(ch);
    };
  }, [qc]);
  return q;
}

/**
 * Badge da sidebar: MESMA queryKey do useWhatsappSla → cache e invalidações
 * compartilhados (o realtime das telas ricas atualiza o badge de graça e o
 * badge é sempre consistente com card/inbox). O `select` deriva só o count
 * do usuário, por observer.
 *
 * Nota honesta sobre intervalos (React Query v5): cada observer mantém o SEU
 * timer de refetchInterval — NÃO existe "menor intervalo vence". Sozinho
 * (maioria das telas), o badge pola a 60s; com uma tela rica aberta (30s) os
 * dois timers coexistem defasados. O ganho real vs a versão anterior (key
 * própria ['whatsapp-sla-badge'] baixando a view inteira em paralelo, sem
 * cache compartilhado) é consistência + realtime de graça + 1 só queryFn —
 * não a redução do número absoluto de fetches quando ambos estão montados.
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
