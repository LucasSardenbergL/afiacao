import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useCompany } from '@/contexts/CompanyContext';
import { hojeSP, addDias, inicioMes, spMeiaNoiteUTC } from '@/lib/dashboard/sp-date';
import { somarReceita, contarAtivos, type OrderRow, type AtividadeRow } from '@/lib/dashboard/team-kpis';

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

      // q1 — receita do mês por order_date_kpi (deriva hoje + mês). Money → throw em erro.
      let qRev = supabase
        .from('sales_orders')
        .select('total, status, order_date_kpi')
        .is('deleted_at', null)
        .gte('order_date_kpi', mesInicio)
        .lt('order_date_kpi', amanha);
      if (selection !== 'all') qRev = qRev.eq('account', selection);

      // q2 — vendedores que lançaram pedido nos últimos 7d (escopo de empresa).
      let qSales = supabase
        .from('sales_orders')
        .select('created_by, created_at')
        .is('deleted_at', null)
        .gte('created_at', inicio7dUTC);
      if (selection !== 'all') qSales = qSales.eq('account', selection);

      const [revRes, salesRes, callsRes, visitsRes] = await Promise.all([
        qRev,
        qSales,
        supabase.from('farmer_calls').select('farmer_id, started_at').gte('started_at', inicio7dUTC),
        supabase.from('route_visits').select('visited_by, check_in_at').gte('check_in_at', inicio7dUTC),
      ]);

      if (revRes.error) throw new Error(revRes.error.message); // dinheiro: erro honesto, não R$0

      const orders: OrderRow[] = (revRes.data ?? []).map((o) => ({
        total: o.total,
        status: o.status,
        order_date_kpi: o.order_date_kpi,
      }));
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
