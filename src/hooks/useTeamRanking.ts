import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useCompany } from '@/contexts/CompanyContext';
import { hojeSP, addDias, inicioMes } from '@/lib/dashboard/sp-date';
import { fetchPedidosMTD } from '@/lib/dashboard/fetch-pedidos-mtd';
import { montarRanking, type RankingResult } from '@/lib/dashboard/team-kpis';

/** commercial_roles que vendem (donos de carteira) — mesma definição de useSalespeople. */
const ROLES_VENDEDOR = ['farmer', 'hunter', 'closer'] as const;

/**
 * Ranking de vendedores do mês (MTD) pro dashboard Master, escopado na empresa do switcher.
 * Atribuição por `created_by` ∈ vendedores reais (commercial_role farmer/hunter/closer);
 * o resto vira bucket "não atribuído". Receita = pedidos válidos do Omie, paginada (não trunca).
 * Read-only; lança em erro (money honesto). Spec: docs/.../2026-06-04-master-visao-time-design.md
 */
export function useTeamRanking() {
  const { selection } = useCompany();
  return useQuery({
    queryKey: ['team-ranking', selection],
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<RankingResult> => {
      const hoje = hojeSP();
      const amanha = addDias(hoje, 1);
      const mesInicio = inicioMes(hoje);

      // Vendedores reais + nomes.
      const { data: roles, error: rErr } = await supabase
        .from('commercial_roles')
        .select('user_id, commercial_role')
        .in('commercial_role', ROLES_VENDEDOR);
      if (rErr) throw new Error(rErr.message);
      const ids = [...new Set((roles ?? []).map((r) => r.user_id).filter(Boolean))];

      const nomes = new Map<string, string>();
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('user_id, name, razao_social')
          .in('user_id', ids);
        for (const p of profs ?? []) nomes.set(p.user_id, p.razao_social || p.name || 'Sem nome');
      }
      const vendedores = new Map<string, string>();
      for (const id of ids) vendedores.set(id, nomes.get(id) ?? 'Sem nome');

      // Pedidos MTD (paginado, lança em erro).
      const orders = await fetchPedidosMTD(selection, mesInicio, amanha);
      return montarRanking(
        orders.map((o) => ({ total: o.total, status: o.status, created_by: o.created_by })),
        vendedores,
      );
    },
  });
}
