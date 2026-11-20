import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { ShoppingBag } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { useDashboardCompany } from '@/hooks/useDashboardCompany';
import { useCockpitChannel } from '@/hooks/dashboard/useCockpitChannel';
import { variantFromScore, type PriorityCandidate } from '@/lib/dashboard/priority-rules';
import { formatCount } from '@/lib/dashboard/format';
import type { KpiSpec } from '@/components/dashboard/cockpit/CockpitKpiRow';
import type { TopListItem } from '@/components/dashboard/cockpit/CockpitTopList';

// "Pendências" = só os tipos de alerta que pedem DECISÃO (a "Fila" da tela de alertas — `TIPOS_FILA` em
// src/components/reposicao/alertas/types.ts; cópia aqui porque a fronteira de módulos proíbe o import).
// Venda atípica é REGISTRO (aceitar não move o motor) e contá-la inflava o card com 236 que ninguém trata.
const TIPOS_PENDENCIA = ['sku_sem_grupo', 'lt_atipico'] as const;

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

type SugeridoPendente = {
  id: number;
  fornecedor_nome: string | null;
  empresa: string;
  valor_total: number | null;
  num_skus: number | null;
};

/** Detalhe do pedido (Gerir pedidos abre por ?id= — `linkDoPedido` em reposicao/pedidos/importar-portal.ts). */
const linkDoPedido = (id: number) => `/admin/reposicao/pedidos?id=${id}`;

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
      let pendencias: number | null = null;
      let aumentos7d: number | null = null;
      let topItems: TopListItem[] = [];
      const erros: Record<'sugeridos' | 'pendencias' | 'topSugeridos' | 'aumentos', string | null> = {
        sugeridos: null,
        pendencias: null,
        topSugeridos: null,
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

      const lerPendencias = async () => {
        try {
          // Aguardando decisão (status 'pendente') E de um tipo que pede decisão (TIPOS_PENDENCIA). Sem o
          // status o card contava a tabela inteira (511 com 238 pendentes); sem o tipo, a venda atípica.
          const { count, error } = await supabase
            .from('eventos_outlier')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'pendente')
            .in('tipo', [...TIPOS_PENDENCIA]);
          if (error) throw new Error(`eventos_outlier (pendências): ${mensagemDeErro(error) ?? 'erro sem mensagem'}`);
          if (count == null) throw new Error('eventos_outlier (pendências): contagem ausente sem error — malformada');
          pendencias = count;
        } catch (e) {
          erros.pendencias = mensagemDeErro(e) ?? 'eventos_outlier (pendências): falha sem mensagem';
        }
      };

      const lerTopSugeridos = async () => {
        try {
          // Lista de topo = os pedidos que esperam a SUA aprovação, cada um abrindo o próprio detalhe.
          // Antes eram alertas de venda atípica: "crítico" ali é pedido grande, não risco, e o clique caía
          // numa visão da tela de alertas que nem mostrava o item.
          const { data: rows, error } = await supabase
            .from('pedido_compra_sugerido')
            .select('id, fornecedor_nome, empresa, valor_total, num_skus')
            .eq('status', 'pendente_aprovacao')
            .order('criado_em', { ascending: false, nullsFirst: false })
            .order('id', { ascending: false })
            .limit(3);
          if (error) throw new Error(`pedido_compra_sugerido (topo de sugeridos): ${mensagemDeErro(error) ?? 'erro sem mensagem'}`);
          if (!rows) throw new Error('pedido_compra_sugerido (topo de sugeridos): data null sem error — malformada');
          topItems = (rows as SugeridoPendente[]).map((p) => {
            // Ausente ≠ zero: valor/SKUs nulos somem da linha em vez de virar "R$ 0".
            const partes = [
              p.empresa,
              p.num_skus == null ? null : `${p.num_skus} SKU${p.num_skus === 1 ? '' : 's'}`,
              p.valor_total == null ? null : brl.format(p.valor_total),
            ].filter(Boolean);
            return {
              id: String(p.id),
              icon: ShoppingBag,
              title: p.fornecedor_nome ?? `Pedido #${p.id}`,
              subtitle: `Aguardando aprovação · ${partes.join(' · ')}`,
              path: linkDoPedido(p.id),
              itemType: 'pedido_compra_sugerido',
            };
          });
        } catch (e) {
          topItems = [];
          erros.topSugeridos = mensagemDeErro(e) ?? 'pedido_compra_sugerido (topo de sugeridos): falha sem mensagem';
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
      await Promise.all([lerSugeridos(), lerPendencias(), lerTopSugeridos(), lerAumentos()]);

      return { sugeridosProntos, pendencias, aumentos7d, topItems, erros, erroTopo: erros.topSugeridos };
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const kpis: KpiSpec[] = useMemo(() => {
    if (!data) return [];
    return [
      { label: 'Sugeridos prontos', value: data.sugeridosProntos === null ? '—' : formatCount(data.sugeridosProntos) },
      { label: 'Pendências', value: data.pendencias === null ? '—' : formatCount(data.pendencias) },
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
