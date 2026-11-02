import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Package, FileCheck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardCompany } from '@/hooks/useDashboardCompany';
import { useCockpitChannel } from '@/hooks/dashboard/useCockpitChannel';
import { variantFromScore, type PriorityCandidate } from '@/lib/dashboard/priority-rules';
import { formatCount } from '@/lib/dashboard/format';
import type { KpiSpec } from '@/components/dashboard/cockpit/CockpitKpiRow';
import type { TopListItem } from '@/components/dashboard/cockpit/CockpitTopList';

export function useEstoqueZone() {
  const { companies, mode } = useDashboardCompany();
  const queryKey = ['dashboard', 'estoque', mode, companies.join(',')];

  const { isLive } = useCockpitChannel({
    zone: 'estoque',
    table: 'nfe_recebimentos',
    queryKeys: [queryKey],
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      let nfPendentes = 0;
      let nfPendentes24h = 0;
      let pickingAbertos = 0;
      let pickingFefoVencendo = 0;
      let recebimentosHoje = 0;
      // Uma lista por leitura: com as leituras em paralelo, um `push` numa lista só deixaria a ordem
      // do topo (NF antes de FEFO) a cargo de quem responde primeiro.
      const topNf: TopListItem[] = [];
      const topFefo: TopListItem[] = [];

      const lerNfPendentes = async () => {
        try {
          const { data: nf } = await supabase
            .from('nfe_recebimentos')
            .select('id, razao_social_emitente, created_at, status')
            .eq('status', 'pendente');
          if (nf) {
            const rows = nf;
            nfPendentes = rows.length;
            nfPendentes24h = rows.filter((r) => r.created_at < cutoff24h).length;
            for (const r of rows.slice(0, 2)) {
              topNf.push({
                id: r.id,
                icon: FileCheck,
                title: r.razao_social_emitente ?? 'Fornecedor',
                subtitle: 'NF aguardando conferência',
                path: `/admin/estoque/recebimento`,
                itemType: 'nfe_pendente',
                badge: r.created_at < cutoff24h ? { label: '>24h', intent: 'error' } : undefined,
              });
            }
          }
        } catch { /* */ }
      };

      const lerPicking = async () => {
        try {
          const { count } = await supabase
            .from('picking_tasks')
            .select('id', { count: 'exact', head: true })
            .in('status', ['pendente', 'em_andamento']);
          pickingAbertos = count ?? 0;
        } catch { /* */ }
      };

      const lerFefo = async () => {
        try {
          const today = new Date();
          today.setDate(today.getDate() + 7);
          // FEFO mora em picking_task_items (validade_fefo/product_descricao), não em picking_tasks.
          const { data: fefo } = await supabase
            .from('picking_task_items')
            .select('id, product_descricao, validade_fefo')
            .in('status', ['pendente', 'em_andamento'])
            .not('validade_fefo', 'is', null)
            .lt('validade_fefo', today.toISOString());
          if (fefo) {
            const rows = fefo as Array<{
              id: string;
              product_descricao: string | null;
              validade_fefo: string | null;
            }>;
            pickingFefoVencendo = rows.length;
            for (const t of rows.slice(0, 1)) {
              topFefo.push({
                id: t.id,
                icon: Package,
                title: t.product_descricao ?? 'Item',
                subtitle: 'Picking com validade próxima',
                path: `/admin/estoque/picking`,
                itemType: 'picking_fefo_vencendo',
                badge: { label: 'FEFO', intent: 'warning' },
              });
            }
          }
        } catch { /* */ }
      };

      const lerRecebimentos = async () => {
        try {
          const { count } = await supabase
            .from('nfe_recebimentos')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'conferido')
            .gte('updated_at', startOfDay.toISOString());
          recebimentosHoje = count ?? 0;
        } catch { /* */ }
      };

      // Leituras independentes: saem juntas (plano v4, lote 10 — C2). Cada bloco engole a própria
      // falha como antes, então o `Promise.all` nunca rejeita.
      await Promise.all([lerNfPendentes(), lerPicking(), lerFefo(), lerRecebimentos()]);
      const topItems = [...topNf, ...topFefo];

      return { nfPendentes, nfPendentes24h, pickingAbertos, pickingFefoVencendo, recebimentosHoje, topItems };
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const kpis: KpiSpec[] = useMemo(() => {
    if (!data) return [];
    return [
      { label: 'NF pendentes', value: formatCount(data.nfPendentes) },
      { label: 'Picking abertos', value: formatCount(data.pickingAbertos) },
      // "Conferidas hoje" (status='conferido') é trabalho do conferente, NÃO entrada de
      // estoque efetiva — rótulo honesto pra não confundir com efetivação no Omie.
      { label: 'Conferidas hoje', value: formatCount(data.recebimentosHoje) },
    ];
  }, [data]);

  const priority: PriorityCandidate | null = useMemo(() => {
    if (!data) return null;
    if (data.nfPendentes24h > 0) {
      const score = 92;
      return {
        zone: 'estoque',
        score,
        item: {
          id: 'nfe_overdue',
          variant: variantFromScore(score),
          icon: FileCheck,
          title: `${data.nfPendentes24h} NF aguardando conferência há >24h`,
          description: 'Bloqueia entrada no estoque e fluxo financeiro. Conferir agora.',
          cta: { label: 'Conferir NF', path: '/admin/estoque/recebimento' },
          metadata: { source: 'estoque.nfe_overdue', count: data.nfPendentes24h },
        },
      };
    }
    if (data.pickingFefoVencendo > 0) {
      const score = 85;
      return {
        zone: 'estoque',
        score,
        item: {
          id: 'picking_fefo',
          variant: variantFromScore(score),
          icon: Package,
          title: `${data.pickingFefoVencendo} picking com validade próxima`,
          description: 'FEFO — lote vence em até 7 dias. Priorizar separação.',
          cta: { label: 'Abrir picking', path: '/admin/estoque/picking' },
          metadata: { source: 'estoque.picking_fefo' },
        },
      };
    }
    return null;
  }, [data]);

  return { kpis, topItems: data?.topItems ?? [], priority, isLoading, isError, refetch, isLive };
}
