import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import type { ZoneId } from '@/lib/dashboard/persona-config';

export interface UseCockpitChannelOptions {
  zone: ZoneId;
  table: string;
  /** Filtro Postgres opcional (ex: 'company=eq.oben'). Sem filtro → escuta toda a tabela. */
  filter?: string;
  /** Chaves do React Query a invalidar quando chega evento. */
  queryKeys: readonly (readonly unknown[])[];
}

// Topic GERACIONAL (mesma classe do 'wa-sla' em useWhatsappSla): o client
// deduplica canal por topic e o removeChannel é async. Topic fixo → um 2º
// mount da mesma zona (ou o efeito re-rodando antes do leave confirmar)
// recebe a instância JÁ inscrita, e o `.on()` lança "cannot add
// `postgres_changes` callbacks ... after `subscribe()`". Sufixo por criação
// garante topic virgem.
let cockpitChannelGen = 0;

/**
 * Padrão de realtime do cockpit: subscreve postgres_changes na tabela,
 * invalida queries no evento, expõe estado de conexão pro LiveBadge,
 * instrumenta connect/disconnect na telemetria.
 */
export function useCockpitChannel({ zone, table, filter, queryKeys }: UseCockpitChannelOptions): { isLive: boolean } {
  const queryClient = useQueryClient();
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    const channelName = `dashboard-${zone}-${table}${filter ? `-${filter}` : ''}-${++cockpitChannelGen}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) },
        () => {
          queryKeys.forEach((k) => queryClient.invalidateQueries({ queryKey: [...k] }));
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setIsLive(true);
          track('dashboard.realtime.channel_connected', { zone, table });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setIsLive(false);
          track('dashboard.realtime.channel_disconnected', { zone, table });
        }
      });

    return () => {
      supabase.removeChannel(channel);
      setIsLive(false);
    };
    // queryKeys array identity may change; consumers should memoize. Including stringified key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone, table, filter, queryClient]);

  return { isLive };
}
