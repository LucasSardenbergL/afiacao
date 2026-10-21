import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { createLeadingTrailingThrottle } from '@/lib/leading-trailing-throttle';
import { linhasCom } from '@/lib/linha-view';
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

const NIVEIS = ['verde', 'amarelo', 'vermelho'] as const satisfies readonly SlaNivel[];
const ehNivel = (v: string): v is SlaNivel => NIVEIS.some((n) => n === v);

/** queryFn compartilhada: badge da sidebar e telas ricas usam a MESMA
 *  queryKey → 1 fetch deduplicado pro app inteiro (a view é scan-heavy).
 *  A view perde o NOT NULL: a borda exige as colunas que a linha precisa (o `nivel` é CASE com
 *  ELSE 'verde', nunca nulo na prod) e confere o vocabulário — fora dele, lança. */
async function fetchWhatsappSla(): Promise<WaSlaRow[]> {
  const res = await supabase.from('v_whatsapp_sla').select('*');
  if (res.error) throw new Error(res.error.message);
  const linhas = linhasCom(res.data, ['conversation_id', 'aguardando_desde', 'minutos_uteis_aguardando', 'nivel'], 'v_whatsapp_sla');
  return linhas.map((l) => {
    if (!ehNivel(l.nivel)) throw new Error(`v_whatsapp_sla: "nivel" = "${l.nivel}" fora do vocabulário`);
    return {
      conversation_id: l.conversation_id,
      customer_user_id: l.customer_user_id,
      phone_e164: l.phone_e164,
      contact_name: l.contact_name,
      owner_user_id: l.owner_user_id,
      aguardando_desde: l.aguardando_desde,
      minutos_uteis_aguardando: l.minutos_uteis_aguardando,
      nivel: l.nivel,
    };
  });
}

const SLA_QUERY_KEY = ['whatsapp', 'sla'] as const;
const REALTIME_THROTTLE_MS = 3000;

/* Canal realtime compartilhado entre TODAS as instâncias do hook (module-level
   de propósito). refcount: cria no 1º acquire, derruba no último release. O
   QueryClient é único no app (App.tsx) — capturá-lo no 1º acquire é seguro. */
let slaRealtimeRefs = 0;
let slaRealtimeTeardown: (() => void) | null = null;
// Topic GERACIONAL: o removeChannel é async e o client deduplica canal por
// topic — recriar 'wa-sla' logo após o teardown (navegação Meu Dia → inbox:
// refs 2→0→1 no mesmo commit) reusaria a instância em state='leaving', cujo
// subscribe() é no-op e que sai da lista de roteamento quando o phx_leave
// confirma → realtime morto silencioso. Com o sufixo de geração, cada
// criação usa um topic virgem e nunca colide com o canal moribundo.
let slaRealtimeGen = 0;

function acquireSlaRealtime(qc: ReturnType<typeof useQueryClient>): () => void {
  slaRealtimeRefs++;
  if (slaRealtimeRefs === 1) {
    const throttle = createLeadingTrailingThrottle(() => {
      qc.invalidateQueries({ queryKey: SLA_QUERY_KEY });
    }, REALTIME_THROTTLE_MS);
    const ch = supabase.channel(`wa-sla-${++slaRealtimeGen}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_messages' }, throttle.fire)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_conversations' }, throttle.fire)
      .subscribe();
    slaRealtimeTeardown = () => {
      // cancel, não flush: sem consumidor montado não há quem precise da
      // invalidação — o próximo mount refaz a query (staleTime 15s).
      throttle.cancel();
      supabase.removeChannel(ch);
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slaRealtimeRefs--;
    if (slaRealtimeRefs === 0 && slaRealtimeTeardown) {
      slaRealtimeTeardown();
      slaRealtimeTeardown = null;
    }
  };
}

export function useWhatsappSla() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: SLA_QUERY_KEY,
    queryFn: fetchWhatsappSla,
    refetchInterval: 30000, // "tiquetaqueia" o contador (now() na view dá minutos frescos a cada fetch)
    refetchIntervalInBackground: false,
    staleTime: 15000,
  });
  // Realtime SINGLETON com refcount (fix da Onda 3): o supabase-js REUSA a
  // instância de canal pelo topic 'wa-sla' — duas instâncias deste hook
  // montadas juntas (Meu Dia: SlaCardMeuDia + useCriticaFila) faziam o 2º
  // subscribe() ser no-op e o match de bindings por índice podia derrubar o
  // canal inteiro (CHANNEL_ERROR silencioso, realtime morto). O canal nasce
  // no 1º consumidor e morre no último; o throttle continua colapsando a
  // rajada (blast/sync em lote) numa revalidação por janela de 3s.
  useEffect(() => acquireSlaRealtime(qc), [qc]);
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
