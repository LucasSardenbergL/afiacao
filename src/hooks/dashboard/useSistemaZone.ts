import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { UserCheck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { variantFromScore, type PriorityCandidate } from '@/lib/dashboard/priority-rules';
import { formatCount } from '@/lib/dashboard/format';
import type { KpiSpec } from '@/components/dashboard/cockpit/CockpitKpiRow';
import type { TopListItem } from '@/components/dashboard/cockpit/CockpitTopList';

function formatTimeSince(iso: string | null): string {
  if (!iso) return '—';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function useSistemaZone() {
  const queryKey = ['dashboard', 'sistema'];

  // Sem Realtime channel intencional: tabela `profiles` é barulhenta demais pra
  // streamar (qualquer login atualiza). Refetch 60s cobre o caso de uso.
  const isLive = false;

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      let aprovacoesPendentes = 0;
      let staffAtivos = 0;
      let ultimaAtividadeIso: string | null = null;
      let topItems: TopListItem[] = [];

      try {
        const { data: pending, count } = await supabase
          .from('profiles')
          .select('user_id, name, created_at', { count: 'exact' })
          .eq('is_approved', false)
          // Exclui clientes-fantasma importados do Omie (nunca pediram conta) do KPI de pendências.
          .or('prospect_source.is.null,prospect_source.neq.omie_import')
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
        // Staff aprovados (proxy de "quantas pessoas operam o sistema"). Conta
        // profiles com role staff (não-customer) via user_roles join via RPC
        // ou query simples. Aqui contamos profiles approved (qualquer role).
        const { count } = await supabase
          .from('profiles')
          .select('user_id', { count: 'exact', head: true })
          .eq('is_approved', true);
        staffAtivos = count ?? 0;
      } catch { /* */ }

      try {
        // Última atividade: max(created_at) de orders OU sales_orders, o que
        // for mais recente. Proxy "sistema vivo / fluindo dado".
        const [ordersRes, salesRes] = await Promise.all([
          supabase.from('orders').select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
          supabase.from('sales_orders').select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
        ]);
        const o = (ordersRes.data as { created_at?: string | null } | null)?.created_at ?? null;
        const s = (salesRes.data as { created_at?: string | null } | null)?.created_at ?? null;
        if (o && s) {
          ultimaAtividadeIso = new Date(o) > new Date(s) ? o : s;
        } else {
          ultimaAtividadeIso = o ?? s;
        }
      } catch { /* */ }

      return { aprovacoesPendentes, staffAtivos, ultimaAtividadeIso, topItems };
    },
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  });

  const kpis: KpiSpec[] = useMemo(() => {
    if (!data) return [];
    return [
      { label: 'Aprovações', value: formatCount(data.aprovacoesPendentes) },
      { label: 'Staff ativos', value: formatCount(data.staffAtivos) },
      { label: 'Última atividade', value: formatTimeSince(data.ultimaAtividadeIso) },
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
