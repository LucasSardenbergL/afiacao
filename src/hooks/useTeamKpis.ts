import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useCompany } from '@/contexts/CompanyContext';
import { hojeSP, addDias, inicioMes, spMeiaNoiteUTC } from '@/lib/dashboard/sp-date';
import { somarReceita, contarAtivos, type AtividadeRow } from '@/lib/dashboard/team-kpis';
import { fetchPedidosMTD } from '@/lib/dashboard/fetch-pedidos-mtd';

export interface TeamKpis {
  receitaHoje: number;
  receitaMes: number;
  ativosHoje: number;
  ativos7d: number;
}

/**
 * KPIs de time pro dashboard Master. Escopo de `account` segue o CompanySwitcher
 * (single → .eq; 'all' → grupo inteiro). Receita = sales_orders válidos (staff lê todos).
 * A query de receita (money) LANÇA em erro → tile "—" honesto (nunca R$0 falso);
 * atividade (calls/visits, sem account) é best-effort. Read-only.
 * Spec: docs/superpowers/specs/2026-06-04-master-visao-time-design.md
 */
export function useTeamKpis() {
  const { selection } = useCompany();
  return useQuery({
    queryKey: ['team-kpis', selection],
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<TeamKpis> => {
      const hoje = hojeSP();
      const amanha = addDias(hoje, 1);
      const mesInicio = inicioMes(hoje);
      const inicioHojeUTC = spMeiaNoiteUTC(hoje);
      const inicio7dUTC = spMeiaNoiteUTC(addDias(hoje, -6)); // hoje + 6 dias atrás

      // q2 — vendedores que lançaram pedido nos últimos 7d (escopo de empresa).
      let qSales = supabase
        .from('sales_orders')
        .select('created_by, created_at')
        .is('deleted_at', null)
        .gte('created_at', inicio7dUTC);
      if (selection !== 'all') qSales = qSales.eq('account', selection);

      const [orders, salesRes, callsRes, visitsRes] = await Promise.all([
        // Receita do mês paginada (deriva hoje + mês); lança em erro (money honesto, não R$0).
        fetchPedidosMTD(selection, mesInicio, amanha),
        qSales,
        supabase.from('farmer_calls').select('farmer_id, started_at').gte('started_at', inicio7dUTC),
        supabase.from('route_visits').select('visited_by, check_in_at').gte('check_in_at', inicio7dUTC),
      ]);

      const receitaHoje = somarReceita(orders, hoje, amanha);
      const receitaMes = somarReceita(orders, mesInicio, amanha);

      // Atividade best-effort (erro → []): sales(empresa) ∪ calls ∪ visits.
      const atividade: AtividadeRow[] = [
        ...(salesRes.data ?? []).map((r) => ({ id: r.created_by, ts: r.created_at })),
        ...(callsRes.data ?? []).map((r) => ({ id: r.farmer_id, ts: r.started_at })),
        ...(visitsRes.data ?? []).map((r) => ({ id: r.visited_by, ts: r.check_in_at })),
      ];
      const ativosHoje = contarAtivos(atividade, inicioHojeUTC);
      const ativos7d = contarAtivos(atividade, inicio7dUTC);

      return { receitaHoje, receitaMes, ativosHoje, ativos7d };
    },
  });
}
