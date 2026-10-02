import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { FileText } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import { useDashboardCompany } from '@/hooks/useDashboardCompany';
import { useCockpitChannel } from '@/hooks/dashboard/useCockpitChannel';
import { variantFromScore, type PriorityCandidate } from '@/lib/dashboard/priority-rules';
import { formatCount } from '@/lib/dashboard/format';
import { hojeSP, addDias } from '@/lib/dashboard/sp-date';
import { agregarVendasDiaKpi, type PedidoVendasKpi } from '@/lib/dashboard/vendas-kpi-dia';
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
      const hoje = hojeSP();
      const ontem = addDias(hoje, -1);
      const amanha = addDias(hoje, 1);

      let orcamentosAguardando = 0;

      // Fonte do dia = order_date_kpi (date puro, 'YYYY-MM-DD') no universo de VENDA da
      // autoridade (`STATUS_NAO_VENDA` + deleted_at), o mesmo do dashboard Master. order_date_kpi
      // é imune a fuso por construção — pedidos do sync Omie deixam de cair no dia errado.
      // ⚠️ A falha LANÇA (money-path §7): antes o erro era descartado e o `catch` devolvia R$ 0 —
      // "não consegui ler" virava "não vendemos nada hoje". Agora a zona mostra o card de erro com
      // retry (`CockpitCardError`), nunca um faturado zero fabricado.
      const { data: pedidos, error: erroPedidos } = await supabase
        .from('sales_orders')
        .select('total, status, order_date_kpi')
        .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
        .is('deleted_at', null)
        .gte('order_date_kpi', ontem)
        .lt('order_date_kpi', amanha);
      if (erroPedidos) throw new Error(`sales_orders (vendas do dia): ${erroPedidos.message}`);
      if (pedidos == null) throw new Error('sales_orders (vendas do dia): data null sem error — malformada');
      const { faturadoHoje, pedidosHoje, faturadoOntem } = agregarVendasDiaKpi(pedidos as PedidoVendasKpi[], hoje);

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
        // NB: não dá pra embeddar profiles(name) — orders.user_id referencia
        // auth.users, não public.profiles, então o PostgREST devolve 400. Busca
        // os nomes num segundo lote por user_id (máx 3 ids, não é N+1).
        const { data: top } = await supabase
          .from('orders')
          .select('id, total, status, created_at, user_id')
          .eq('status', 'orcamento_enviado')
          .lt('created_at', cutoff)
          .order('total', { ascending: false })
          .limit(3);
        const rows = (top ?? []) as Array<{
          id: string;
          total?: number | string | null;
          user_id?: string | null;
        }>;
        const userIds = [...new Set(rows.map((o) => o.user_id).filter(Boolean))] as string[];
        const nameMap = new Map<string, string>();
        if (userIds.length > 0) {
          const { data: profs } = await supabase
            .from('profiles')
            .select('user_id, name')
            .in('user_id', userIds);
          for (const p of (profs ?? []) as Array<{ user_id: string; name: string | null }>) {
            if (p.name) nameMap.set(p.user_id, p.name);
          }
        }
        topItems = rows.map((o) => ({
          id: o.id,
          icon: FileText,
          title: (o.user_id && nameMap.get(o.user_id)) || 'Cliente',
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
