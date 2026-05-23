import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { ShoppingBag, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardCompany } from '@/hooks/useDashboardCompany';
import { useCockpitChannel } from '@/hooks/dashboard/useCockpitChannel';
import { variantFromScore, type PriorityCandidate } from '@/lib/dashboard/priority-rules';
import { formatCount } from '@/lib/dashboard/format';
import type { KpiSpec } from '@/components/dashboard/cockpit/CockpitKpiRow';
import type { TopListItem } from '@/components/dashboard/cockpit/CockpitTopList';

export function useReposicaoZone() {
  const { companies, mode } = useDashboardCompany();
  const queryKey = ['dashboard', 'reposicao', mode, companies.join(',')];

  const { isLive } = useCockpitChannel({
    zone: 'reposicao',
    table: 'pedido_compra_sugerido',
    queryKeys: [queryKey],
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      let sugeridosProntos = 0;
      let alertasAtivos = 0;
      let aumentos7d = 0;
      let topItems: TopListItem[] = [];

      try {
        const { count } = await supabase
          .from('pedido_compra_sugerido')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pronto');
        sugeridosProntos = count ?? 0;
      } catch { /* */ }

      try {
        const { data: alerts, count } = await supabase
          .from('eventos_outlier')
          .select('id, tipo, sku_descricao, severidade', { count: 'exact' })
          .order('detectado_em', { ascending: false, nullsFirst: false })
          .limit(5);
        alertasAtivos = count ?? 0;
        if (alerts) {
          const rows = alerts as Array<{
            id: number;
            tipo: string;
            sku_descricao: string | null;
            severidade: string;
          }>;
          topItems = rows.slice(0, 3).map((a) => ({
            id: String(a.id),
            icon: AlertTriangle,
            title: a.sku_descricao ?? a.tipo ?? 'Alerta',
            subtitle: `Severidade ${a.severidade ?? 'média'}`,
            path: '/admin/reposicao/sessao',
            itemType: 'outlier_event',
            badge: a.severidade === 'alta' || a.severidade === 'critica'
              ? { label: a.severidade, intent: 'error' as const }
              : undefined,
          }));
        }
      } catch { /* */ }

      try {
        const { count } = await supabase
          .from('fornecedor_aumento_anunciado')
          .select('id', { count: 'exact', head: true })
          .gte('criado_em', sevenDaysAgo);
        aumentos7d = count ?? 0;
      } catch { /* */ }

      return { sugeridosProntos, alertasAtivos, aumentos7d, topItems };
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const kpis: KpiSpec[] = useMemo(() => {
    if (!data) return [];
    return [
      { label: 'Sugeridos prontos', value: formatCount(data.sugeridosProntos) },
      { label: 'Alertas ativos', value: formatCount(data.alertasAtivos) },
      { label: 'Aumentos 7d', value: formatCount(data.aumentos7d) },
    ];
  }, [data]);

  const priority: PriorityCandidate | null = useMemo(() => {
    if (!data) return null;
    if (data.sugeridosProntos > 0) {
      const score = 88;
      return {
        zone: 'reposicao',
        score,
        item: {
          id: 'sugeridos_pronto',
          variant: variantFromScore(score),
          icon: ShoppingBag,
          title: `${data.sugeridosProntos} pedido(s) de compra prontos para aplicar`,
          description: 'Sessão de reposição concluiu sugestões. Revisar e enviar ao Omie.',
          cta: { label: 'Abrir cockpit', path: '/admin/reposicao/sessao' },
          metadata: { source: 'reposicao.sugerido_pronto' },
        },
      };
    }
    return null;
  }, [data]);

  return { kpis, topItems: data?.topItems ?? [], priority, isLoading, isError, refetch, isLive };
}
