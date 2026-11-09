import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { ShoppingBag, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { mensagemDeErro } from '@/lib/erro-mensagem';
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

      // `null` = a leitura FALHOU (≠ zero medido): o KPI mostra "—" e o cartão de prioridade não
      // dispara com base numa contagem que ninguém leu. O supabase-js DEVOLVE o erro (não lança),
      // então cada bloco lança o seu para o `catch` ver (ausente ≠ zero, mesma regra do lote 5 na
      // zona Sistema). `erros` guarda o porquê, por bloco.
      let sugeridosProntos: number | null = null;
      let alertasAtivos: number | null = null;
      let aumentos7d: number | null = null;
      let topItems: TopListItem[] = [];
      const erros: Record<'sugeridos' | 'alertas' | 'topAlertas' | 'aumentos', string | null> = {
        sugeridos: null,
        alertas: null,
        topAlertas: null,
        aumentos: null,
      };

      const lerSugeridos = async () => {
        try {
          // "Prontos" = sugestões aguardando decisão do founder. O status 'pronto' não
          // existe nesta tabela (era 0 permanente, o card nunca disparava); o estado real
          // que precisa de ação é 'pendente_aprovacao'.
          const { count, error } = await supabase
            .from('pedido_compra_sugerido')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'pendente_aprovacao');
          if (error) throw new Error(`pedido_compra_sugerido (sugeridos prontos): ${mensagemDeErro(error) ?? 'erro sem mensagem'}`);
          if (count == null) throw new Error('pedido_compra_sugerido (sugeridos prontos): contagem ausente sem error — malformada');
          sugeridosProntos = count;
        } catch (e) {
          erros.sugeridos = mensagemDeErro(e) ?? 'pedido_compra_sugerido (sugeridos prontos): falha sem mensagem';
        }
      };

      const lerAlertas = async () => {
        try {
          // "Ativos" = aguardando decisão (status 'pendente'). Sem esse filtro o card contava a
          // tabela inteira — inclusive aceitos/excluídos/resolvidos — e mostrava 511 com 238 pendentes.
          const { count, error } = await supabase
            .from('eventos_outlier')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'pendente');
          if (error) throw new Error(`eventos_outlier (alertas ativos): ${mensagemDeErro(error) ?? 'erro sem mensagem'}`);
          if (count == null) throw new Error('eventos_outlier (alertas ativos): contagem ausente sem error — malformada');
          alertasAtivos = count;
        } catch (e) {
          erros.alertas = mensagemDeErro(e) ?? 'eventos_outlier (alertas ativos): falha sem mensagem';
        }
      };

      const lerTopAlertas = async () => {
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
          // Uma severidade que falha deixaria a lista sem os críticos e com cara de completa.
          porSeveridade.forEach((r, i) => {
            if (r.error) throw new Error(`eventos_outlier (topo de alertas, ${SEVERIDADES[i]}): ${mensagemDeErro(r.error) ?? 'erro sem mensagem'}`);
            if (!r.data) throw new Error(`eventos_outlier (topo de alertas, ${SEVERIDADES[i]}): data null sem error — malformada`);
          });
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
        } catch (e) {
          topItems = [];
          erros.topAlertas = mensagemDeErro(e) ?? 'eventos_outlier (topo de alertas): falha sem mensagem';
        }
      };

      const lerAumentos = async () => {
        try {
          const { count, error } = await supabase
            .from('fornecedor_aumento_anunciado')
            .select('id', { count: 'exact', head: true })
            .gte('criado_em', sevenDaysAgo);
          if (error) throw new Error(`fornecedor_aumento_anunciado (aumentos 7d): ${mensagemDeErro(error) ?? 'erro sem mensagem'}`);
          if (count == null) throw new Error('fornecedor_aumento_anunciado (aumentos 7d): contagem ausente sem error — malformada');
          aumentos7d = count;
        } catch (e) {
          erros.aumentos = mensagemDeErro(e) ?? 'fornecedor_aumento_anunciado (aumentos 7d): falha sem mensagem';
        }
      };

      // Leituras independentes: saem juntas (plano v4, lote 10 — C2). Cada bloco degrada só o próprio
      // KPI, então o `Promise.all` nunca rejeita.
      await Promise.all([lerSugeridos(), lerAlertas(), lerTopAlertas(), lerAumentos()]);

      return { sugeridosProntos, alertasAtivos, aumentos7d, topItems, erros, erroTopo: erros.topAlertas };
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const kpis: KpiSpec[] = useMemo(() => {
    if (!data) return [];
    return [
      { label: 'Sugeridos prontos', value: data.sugeridosProntos === null ? '—' : formatCount(data.sugeridosProntos) },
      { label: 'Alertas ativos', value: data.alertasAtivos === null ? '—' : formatCount(data.alertasAtivos) },
      { label: 'Aumentos 7d', value: data.aumentos7d === null ? '—' : formatCount(data.aumentos7d) },
    ];
  }, [data]);

  const priority: PriorityCandidate | null = useMemo(() => {
    if (!data) return null;
    if (data.sugeridosProntos !== null && data.sugeridosProntos > 0) {
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

  return {
    kpis,
    topItems: data?.topItems ?? [],
    priority,
    // Leitura do topo que falhou: a zona avisa no lugar de "Sem alertas ativos.".
    erroTopo: data?.erroTopo ?? null,
    erros: data?.erros ?? null,
    isLoading,
    isError,
    refetch,
    isLive,
  };
}
