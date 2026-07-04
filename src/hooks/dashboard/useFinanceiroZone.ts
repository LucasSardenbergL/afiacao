import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { DollarSign, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { getAgingReceber, getTopInadimplentes } from '@/services/financeiroService';
import { useDashboardCompany } from '@/hooks/useDashboardCompany';
import { variantFromScore, type PriorityCandidate } from '@/lib/dashboard/priority-rules';
import type { KpiSpec } from '@/components/dashboard/cockpit/CockpitKpiRow';
import type { TopListItem } from '@/components/dashboard/cockpit/CockpitTopList';

const fmtBRL = (v: number) => {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${Math.round(v / 1_000)}k`;
  return `R$ ${v.toLocaleString('pt-BR')}`;
};

export function useFinanceiroZone() {
  const { mode, primary } = useDashboardCompany();
  const queryKey = ['dashboard', 'financeiro', mode, primary];

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      let aging90 = 0;
      let projecao13Total: number | null = null;
      let confiabilidadePct: number | null = null;
      let topItems: TopListItem[] = [];

      try {
        // Campo real do AgingData é vencido_90_plus_valor; 'faixa_90_mais'/'90+' não
        // existem (o cast escondia — aging90 era 0 permanente e o alerta >90d nunca dava).
        const aging = await getAgingReceber('all');
        aging90 = aging.vencido_90_plus_valor ?? 0;
      } catch { /* */ }

      try {
        const inadList = await getTopInadimplentes('all', 3);
        const rows = (inadList ?? []) as Array<{
          id?: string | null;
          cliente_nome?: string | null;
          nome?: string | null;
          valor_total?: number | null;
          total?: number | null;
          total_vencido?: number | null;
        }>;
        topItems = rows.map((r, i) => ({
          id: r.id ?? `inad-${i}`,
          icon: AlertTriangle,
          title: r.cliente_nome ?? r.nome ?? 'Cliente',
          subtitle: `${fmtBRL(Number(r.valor_total ?? r.total ?? r.total_vencido ?? 0))} em aberto`,
          path: '/financeiro/cockpit',
          itemType: 'inadimplente',
          badge: { label: 'crítico', intent: 'error' as const },
        }));
      } catch { /* */ }

      try {
        // fin_projecao_13_semanas é function (RPC), não tabela. Retorna 13 linhas
        // com saldo_projetado por semana — pegamos o último (semana 13 = saldo
        // final projetado).
        // p_company=null no modo 'all' = projeção consolidada (a função trata NULL).
        // Cast: tipo gerado não inclui null, mas PostgREST aceita em runtime.
        const rpcParams = (mode === 'all' ? { p_company: null } : { p_company: primary }) as unknown as { p_company?: string };
        const { data: proj } = await supabase.rpc('fin_projecao_13_semanas', rpcParams);
        if (Array.isArray(proj) && proj.length > 0) {
          const last = proj[proj.length - 1] as { saldo_projetado?: number | null };
          projecao13Total = Number(last.saldo_projetado ?? 0);
        }
      } catch { /* */ }

      try {
        const { data: conf } = await supabase
          .from('fin_confiabilidade')
          .select('pct_valor_mapeado, pct_mov_conciliado, fechamento_status')
          .order('mes', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (conf) {
          const row = conf as {
            pct_valor_mapeado?: number | null;
            pct_mov_conciliado?: number | null;
            fechamento_status?: string | null;
          };
          const pctMap = Number(row.pct_valor_mapeado ?? 0);
          const pctConc = Number(row.pct_mov_conciliado ?? 0);
          const fech = row.fechamento_status === 'fechado' ? 30 : 0;
          confiabilidadePct = Math.round(pctMap * 0.4 + pctConc * 0.3 + fech);
        }
      } catch { /* */ }

      return { aging90, projecao13Total, confiabilidadePct, topItems };
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });

  const kpis: KpiSpec[] = useMemo(() => {
    if (!data) return [];
    return [
      { label: 'Aging >90d', value: fmtBRL(data.aging90) },
      { label: 'Projeção 13sem', value: data.projecao13Total !== null ? fmtBRL(data.projecao13Total) : '—' },
      { label: 'Confiabilidade', value: data.confiabilidadePct !== null ? `${data.confiabilidadePct}%` : '—' },
    ];
  }, [data]);

  const priority: PriorityCandidate | null = useMemo(() => {
    if (!data) return null;
    if (data.aging90 > 50_000) {
      const score = 90;
      return {
        zone: 'financeiro',
        score,
        item: {
          id: 'aging_critico',
          variant: variantFromScore(score),
          icon: DollarSign,
          title: `${fmtBRL(data.aging90)} em aging >90d`,
          description: 'Inadimplência crítica acima de 90 dias. Acionar cobrança.',
          cta: { label: 'Abrir financeiro', path: '/financeiro/cockpit' },
          metadata: { source: 'financeiro.aging_critico', value: data.aging90 },
        },
      };
    }
    return null;
  }, [data]);

  return { kpis, topItems: data?.topItems ?? [], priority, isLoading, isError, refetch, isLive: false };
}
