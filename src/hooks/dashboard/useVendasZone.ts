import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { FileText } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardCompany } from '@/hooks/useDashboardCompany';
import { useCockpitChannel } from '@/hooks/dashboard/useCockpitChannel';
import { variantFromScore, type PriorityCandidate } from '@/lib/dashboard/priority-rules';
import { formatCount } from '@/lib/dashboard/format';
import type { KpiSpec } from '@/components/dashboard/cockpit/CockpitKpiRow';
import type { TopListItem } from '@/components/dashboard/cockpit/CockpitTopList';

const fmtBRL = (v: number) => {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${Math.round(v / 1_000)}k`;
  return `R$ ${v.toLocaleString('pt-BR')}`;
};

export function useVendasZone() {
  const { companies, mode } = useDashboardCompany();
  const queryKey = ['dashboard', 'vendas', mode, companies.join(',')];

  const { isLive } = useCockpitChannel({
    zone: 'vendas',
    table: 'sales_orders',
    queryKeys: [queryKey],
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const yesterdayStart = new Date(startOfDay);
      yesterdayStart.setDate(yesterdayStart.getDate() - 1);

      let faturadoHoje = 0;
      let faturadoOntem = 0;
      let pedidosHoje = 0;
      let orcamentosAguardando = 0;

      try {
        // sales_orders hoje
        const { data: hoje } = await supabase
          .from('sales_orders')
          .select('total')
          .gte('created_at', startOfDay.toISOString());
        if (hoje) {
          const rows = hoje as Array<{ total?: number | string | null }>;
          pedidosHoje = rows.length;
          faturadoHoje = rows.reduce((s, r) => s + Number(r.total ?? 0), 0);
        }

        // sales_orders ontem
        const { data: ontem } = await supabase
          .from('sales_orders')
          .select('total')
          .gte('created_at', yesterdayStart.toISOString())
          .lt('created_at', startOfDay.toISOString());
        if (ontem) {
          const rows = ontem as Array<{ total?: number | string | null }>;
          faturadoOntem = rows.reduce((s, r) => s + Number(r.total ?? 0), 0);
        }
      } catch { /* tabela ausente — devolve 0 */ }

      try {
        const { count } = await supabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'orcamento_enviado');
        orcamentosAguardando = count ?? 0;
      } catch { /* */ }

      // Top-3: pedidos sem ação >24h por valor
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let topItems: TopListItem[] = [];
      try {
        const { data: top } = await supabase
          .from('orders')
          .select('id, total, status, created_at, profiles(name)')
          .eq('status', 'orcamento_enviado')
          .lt('created_at', cutoff)
          .order('total', { ascending: false })
          .limit(3);
        const rows = (top ?? []) as Array<{
          id: string;
          total?: number | string | null;
          profiles?: { name?: string | null } | null;
        }>;
        topItems = rows.map((o) => ({
          id: o.id,
          icon: FileText,
          title: o.profiles?.name ?? 'Cliente',
          subtitle: `Orçamento ${fmtBRL(Number(o.total ?? 0))} aguardando >24h`,
          path: `/admin/orders/${o.id}`,
          itemType: 'orcamento_pending',
          badge: { label: 'Ação', intent: 'warning' },
        }));
      } catch { /* */ }

      const deltaPct = faturadoOntem > 0
        ? Math.round(((faturadoHoje - faturadoOntem) / faturadoOntem) * 100)
        : undefined;

      return {
        faturadoHoje,
        pedidosHoje,
        orcamentosAguardando,
        deltaPct,
        topItems,
      };
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const kpis: KpiSpec[] = useMemo(() => {
    if (!data) return [];
    return [
      { label: 'Faturado hoje', value: fmtBRL(data.faturadoHoje), deltaPct: data.deltaPct },
      { label: 'Pedidos hoje', value: formatCount(data.pedidosHoje) },
      { label: 'Aguardando', value: formatCount(data.orcamentosAguardando) },
    ];
  }, [data]);

  const priority: PriorityCandidate | null = useMemo(() => {
    if (!data?.topItems?.length) return null;
    const first = data.topItems[0];
    const score = 75; // orçamento >24h = warning
    return {
      zone: 'vendas',
      score,
      item: {
        id: first.id,
        variant: variantFromScore(score),
        icon: FileText,
        title: `Orçamento >24h aguardando — ${first.title}`,
        description: 'Cliente espera resposta. Abrir e aprovar ou recusar.',
        cta: { label: 'Abrir orçamento', path: first.path },
        metadata: { source: 'vendas.orcamento_pending' },
      },
    };
  }, [data]);

  return { kpis, topItems: data?.topItems ?? [], priority, isLoading, isError, refetch, isLive };
}
