import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { UserCheck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { variantFromScore, type PriorityCandidate } from '@/lib/dashboard/priority-rules';
import { formatCount } from '@/lib/dashboard/format';
import type { KpiSpec } from '@/components/dashboard/cockpit/CockpitKpiRow';
import type { TopListItem } from '@/components/dashboard/cockpit/CockpitTopList';

export function useSistemaZone() {
  const queryKey = ['dashboard', 'sistema'];

  // Sem Realtime channel intencional: tabela `profiles` é barulhenta demais pra
  // streamar (qualquer login atualiza). Refetch 60s cobre o caso de uso.
  const isLive = false;

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      let aprovacoesPendentes = 0;
      let syncOmie: string | null = null;
      let syncSayerlack: string | null = null;
      let topItems: TopListItem[] = [];

      try {
        const { data: pending, count } = await supabase
          .from('profiles')
          .select('user_id, name, created_at', { count: 'exact' })
          .eq('is_approved', false)
          .order('created_at', { ascending: true })
          .limit(3);
        aprovacoesPendentes = count ?? 0;
        if (pending) {
          const rows = pending as Array<{
            user_id: string;
            name?: string | null;
            created_at?: string | null;
          }>;
          topItems = rows.map((p) => ({
            id: p.user_id,
            icon: UserCheck,
            title: p.name ?? 'Usuário sem nome',
            subtitle: 'Aguardando liberação',
            path: '/admin/approvals',
            itemType: 'pending_approval',
            badge: { label: 'novo', intent: 'info' as const },
          }));
        }
      } catch { /* */ }

      try {
        const { data: lastOmie } = await supabase
          .from('sync_logs')
          .select('finished_at, status')
          .eq('integration', 'omie')
          .order('finished_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        const row = lastOmie as { finished_at?: string | null; status?: string | null } | null;
        syncOmie = row?.status ?? null;
      } catch { /* tabela ausente */ }

      try {
        const { data: lastSay } = await supabase
          .from('sync_logs')
          .select('finished_at, status')
          .eq('integration', 'sayerlack')
          .order('finished_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        const row = lastSay as { finished_at?: string | null; status?: string | null } | null;
        syncSayerlack = row?.status ?? null;
      } catch { /* */ }

      return { aprovacoesPendentes, syncOmie, syncSayerlack, topItems };
    },
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  });

  const kpis: KpiSpec[] = useMemo(() => {
    if (!data) return [];
    return [
      { label: 'Aprovações', value: formatCount(data.aprovacoesPendentes) },
      { label: 'Sync Omie', value: data.syncOmie ?? '—' },
      { label: 'Sync Sayerlack', value: data.syncSayerlack ?? '—' },
    ];
  }, [data]);

  const priority: PriorityCandidate | null = useMemo(() => {
    if (!data) return null;
    if (data.aprovacoesPendentes >= 3) {
      const score = 70;
      return {
        zone: 'sistema',
        score,
        item: {
          id: 'pending_approvals',
          variant: variantFromScore(score),
          icon: UserCheck,
          title: `${data.aprovacoesPendentes} liberações aguardando`,
          description: 'Novos cadastros sem acesso ainda. Revisar e aprovar.',
          cta: { label: 'Abrir aprovações', path: '/admin/approvals' },
          metadata: { source: 'sistema.pending_approvals' },
        },
      };
    }
    return null;
  }, [data]);

  return { kpis, topItems: data?.topItems ?? [], priority, isLoading, isError, refetch, isLive };
}
