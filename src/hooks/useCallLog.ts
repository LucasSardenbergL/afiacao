// src/hooks/useCallLog.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { acknowledgeMissed } from '@/lib/call-log/record';
import type { CallLogRow } from '@/types/call-log';

export type CallLogTab = 'recentes' | 'recebidas' | 'perdidas' | 'feitas' | 'time';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyTab(query: any, tab: CallLogTab) {
  switch (tab) {
    case 'recebidas': return query.eq('direction', 'inbound').neq('status', 'missed');
    case 'perdidas': return query.eq('direction', 'inbound').eq('status', 'missed');
    case 'feitas': return query.eq('direction', 'outbound');
    case 'time': return query; // RLS de time já filtra; sem .eq farmer_id
    case 'recentes':
    default: return query;
  }
}

export function useCallLog(tab: CallLogTab, userId: string | undefined) {
  return useQuery({
    queryKey: ['call_log', tab, userId],
    enabled: !!userId,
    queryFn: async (): Promise<CallLogRow[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = (supabase.from('call_log') as any).select('*').order('started_at', { ascending: false }).limit(50);
      if (tab !== 'time') q = q.eq('farmer_id', userId);
      q = applyTab(q, tab);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as CallLogRow[];
    },
    staleTime: 30_000,
  });
}

export function useMissedCount(userId: string | undefined) {
  return useQuery({
    queryKey: ['call_log_missed_count', userId],
    enabled: !!userId,
    queryFn: async (): Promise<number> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count } = await (supabase.from('call_log') as any)
        .select('id', { count: 'exact', head: true })
        .eq('farmer_id', userId).eq('direction', 'inbound').eq('status', 'missed').is('acknowledged_at', null);
      return count ?? 0;
    },
    refetchInterval: 30_000,
  });
}

export function useAcknowledgeMissed(userId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => { if (userId) await acknowledgeMissed(userId); },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['call_log_missed_count', userId] });
      qc.invalidateQueries({ queryKey: ['call_log'] });
    },
  });
}
