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

// Valores gravados em eventos_outlier.severidade, na ordem de prioridade da lista de topo.
const SEVERIDADES = ['critico', 'atencao', 'info'] as const;

const SEVERIDADE_LABEL: Record<string, string> = { critico: 'Crítico', atencao: 'Atenção', info: 'Info' };

const TIPO_LABEL: Record<string, string> = {
  venda_atipica: 'Venda atípica',
  lt_atipico: 'Lead time atípico',
  sku_sem_grupo: 'SKU sem grupo',
  sku_inativado_omie: 'Inativado no Omie',
  sku_reativado_omie: 'Reativado no Omie',
};

type AlertaPendente = { id: number; tipo: string; sku_descricao: string | null; severidade: string };

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
        // "Prontos" = sugestões aguardando decisão do founder. O status 'pronto' não
        // existe nesta tabela (era 0 permanente, o card nunca disparava); o estado real
        // que precisa de ação é 'pendente_aprovacao'.
        const { count } = await supabase
          .from('pedido_compra_sugerido')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pendente_aprovacao');
        sugeridosProntos = count ?? 0;
      } catch { /* */ }

      try {
        // "Ativos" = aguardando decisão (status 'pendente'). Sem esse filtro o card contava a
        // tabela inteira — inclusive aceitos/excluídos/resolvidos — e mostrava 511 com 238 pendentes.
        const { count } = await supabase
          .from('eventos_outlier')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pendente');
        alertasAtivos = count ?? 0;
      } catch { /* */ }

      try {
        // Lista de topo: pendentes, crítico antes de atenção antes de info (mais recente dentro de
        // cada severidade). Uma leitura por severidade porque a ordem alfabética do texto não serve.
        const porSeveridade = await Promise.all(
          SEVERIDADES.map((sev) =>
            supabase
              .from('eventos_outlier')
              .select('id, tipo, sku_descricao, severidade')
              .eq('status', 'pendente')
              .eq('severidade', sev)
              .order('detectado_em', { ascending: false, nullsFirst: false })
              .limit(3),
          ),
        );
        const rows = porSeveridade.flatMap((r) => (r.data ?? []) as AlertaPendente[]);
        topItems = rows.slice(0, 3).map((a) => ({
          id: String(a.id),
          icon: AlertTriangle,
          title: a.sku_descricao ?? a.tipo ?? 'Alerta',
          subtitle: `${TIPO_LABEL[a.tipo] ?? a.tipo} · ${SEVERIDADE_LABEL[a.severidade] ?? a.severidade}`,
          path: '/admin/reposicao/alertas',
          itemType: 'outlier_event',
          badge: a.severidade === 'critico'
            ? { label: 'crítico', intent: 'error' as const }
            : a.severidade === 'atencao'
              ? { label: 'atenção', intent: 'warning' as const }
              : undefined,
        }));
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
          cta: { label: 'Abrir pedidos de compra', path: '/admin/reposicao/pedidos' },
          metadata: { source: 'reposicao.sugerido_pronto' },
        },
      };
    }
    return null;
  }, [data]);

  return { kpis, topItems: data?.topItems ?? [], priority, isLoading, isError, refetch, isLive };
}
