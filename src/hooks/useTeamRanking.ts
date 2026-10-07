import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useCompany } from '@/contexts/CompanyContext';
import { hojeSP, addDias, inicioMes } from '@/lib/dashboard/sp-date';
import { fetchPedidosMTD } from '@/lib/dashboard/fetch-pedidos-mtd';
import { fetchDonosCarteira } from '@/lib/dashboard/fetch-donos-carteira';
import { montarRanking, type RankingResult } from '@/lib/dashboard/team-kpis';

/** commercial_roles que vendem (donos de carteira) — mesma definição de useSalespeople. */
const ROLES_VENDEDOR = ['farmer', 'hunter', 'closer'] as const;

/**
 * Ranking de vendedores do mês (MTD) pro dashboard Master, escopado na empresa do switcher.
 * Atribuição pelo DONO ATUAL da carteira ELEGÍVEL do cliente do pedido (a régua da positivação e da
 * comissão). Dono que não é farmer/hunter/closer → "carteira de não-vendedor"; cliente sem carteira →
 * "não atribuído". O `created_by` não entra: na importada é carimbo técnico do importador.
 * Receita = pedidos válidos, paginada (não trunca). Read-only; pedidos e carteira LANÇAM em erro — o card
 * mostra "Indisponível", nunca "Sem vendedor atribuído" por falha de leitura.
 * Spec: docs/superpowers/specs/2026-10-06-ranking-atribuicao-por-carteira-design.md
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
      // data nula sem error = malformada, não "nenhum vendedor": sem vendedores, toda venda com carteira
      // iria para "Carteira de não-vendedor" — veredito falso no card (classe #1338→#1564).
      if (roles == null) throw new Error('commercial_roles: data null sem error — malformada, não é fim');
      const ids = [...new Set(roles.map((r) => r.user_id).filter(Boolean))];

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

      // Pedidos MTD (paginado, lança em erro) → dono da carteira de cada cliente (lança em erro).
      const orders = await fetchPedidosMTD(selection, mesInicio, amanha);
      const clienteIds = orders.map((o) => o.customer_user_id).filter((id): id is string => id != null);
      const donoPorCliente = await fetchDonosCarteira(clienteIds);
      return montarRanking(
        orders.map((o) => ({ total: o.total, status: o.status, customer_user_id: o.customer_user_id })),
        { donoPorCliente, vendedores },
      );
    },
  });
}
