import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ajusteDoJson } from '@/lib/scoring/borda-ajuste';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useCarteirasQueEuCubro } from '@/hooks/useCoverage';
import {
  coletarEmLotesConcorrente,
  fetchAssignmentsElegiveis,
  LOTE_IN,
  ownersDoAlvoNaLente,
} from '@/lib/carteira/escopo-clientes';
import type { ScoreAdjustment } from '@/lib/scoring/types';

export interface CarteiraScoreRow {
  customer_user_id: string;
  health_score: number | null;
  health_class: string | null;
  priority_score: number | null;
  churn_risk: number | null;
  expansion_score: number | null;
  recover_score: number | null;
  revenue_potential: number | null;
  days_since_last_purchase: number | null;
  avg_monthly_spend_180d: number | null;
  signal_modifiers: ScoreAdjustment | null;
  last_signal_recalc_at: string | null;
  sales_history_status: string | null;
  /** dono original quando o cliente vem de cobertura (farmer_id ≠ eu); null se for meu. */
  coberto_de: string | null;
}

const COLUNAS_SCORE =
  'customer_user_id, health_score, health_class, priority_score, churn_risk, expansion_score, recover_score, revenue_potential, days_since_last_purchase, avg_monthly_spend_180d, signal_modifiers, sales_history_status, last_signal_recalc_at';

/**
 * Scores da CARTEIRA INTEIRA de quem está olhando — sem corte por ranking (onda A de Clientes).
 *
 * Antes: `farmer_id IN donos ORDER BY priority_score DESC LIMIT 200`. O teto cortava pelo eixo
 * ERRADO: a nota antiga punha os clientes mais mortos no topo, e os 200 primeiros da vendedora eram
 * 100% `stale` — o "Meu dia" não continha nenhum ativo (CLAUDE.md: "o teto é o EIXO"; aumentar o
 * limite só adiava). Agora: UNIÃO com a carteira — todos os clientes elegíveis dos donos, e quem
 * escolhe o top N é `buildAgendaItems`, em memória, sobre o conjunto completo.
 *
 * ESCOPO = o MESMO da lista de clientes (`fetchAssignmentsElegiveis`: `carteira_assignments` com
 * `eligible = true`), recortado pelos donos [eu, ...carteiras que cubro] (na lente: o alvo + o que
 * ELE cobre, como na lista). O `farmer_id` deixou de ser o eixo: divergia do assignment (gestor: 14.159
 * linhas por farmer_id contra 12.701 elegíveis, medido 2026-11-24 — os 1.458 a mais são não elegíveis).
 * Divergência QUE FICA, por desenho: gestor/master na LISTA vê a base completa (`resolveModoEscopo`);
 * no "Meu dia" vê só a própria carteira — agenda é de quem atende, não de quem supervisiona.
 *
 * Cap de 1000 do PostgREST: assignments paginados por `.range()` + ordem total; scores por id em
 * lotes de 150 (cada lote < 1000 linhas por `UNIQUE(customer_user_id)`). Erro em qualquer página ou
 * lote LANÇA — agenda sobre carteira parcial escolheria o top N do pedaço errado.
 *
 * 🔐 RLS de LEITURA (`fcs_select_carteira`): `pode_ver_carteira_completa(uid) OR
 * private.carteira_visivel_para(customer_user_id, uid)`. Para vendedor não-gestor a RLS é a fronteira
 * real; o filtro de donos aqui é recorte de exibição. Impersonação é master-only.
 */
export function useMyCarteiraScores() {
  const { user } = useAuth();
  const { isImpersonating, effectiveUserId } = useImpersonation();
  const { coveredIds } = useCarteirasQueEuCubro();
  const ownerIds = isImpersonating && effectiveUserId ? [effectiveUserId] : (user ? [user.id, ...coveredIds] : []);
  const baseId = isImpersonating ? effectiveUserId : user?.id;

  return useQuery({
    queryKey: ['my-carteira-scores', isImpersonating ? `as:${effectiveUserId}` : user?.id, coveredIds.sort().join(',')],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<CarteiraScoreRow[]> => {
      if (!user) return [];

      const donos = isImpersonating && effectiveUserId ? await ownersDoAlvoNaLente(effectiveUserId) : ownerIds;
      const assignments = await fetchAssignmentsElegiveis(donos, 'carteira_assignments/meu-dia');
      const donoPorCliente = new Map(assignments.map((a) => [a.customer_user_id, a.owner_user_id] as [string, string]));
      const ids = [...donoPorCliente.keys()];

      const linhas = await coletarEmLotesConcorrente(ids, LOTE_IN, 4, async (lote) => {
        const { data, error } = await supabase.from('farmer_client_scores')
          .select(COLUNAS_SCORE)
          .in('customer_user_id', lote);
        if (error) throw error;
        return data ?? [];
      });
      return linhas.map(({ signal_modifiers, ...row }) => {
        const dono = donoPorCliente.get(row.customer_user_id) ?? null;
        return {
          ...row,
          // jsonb `signal_modifiers` lido por forma (na prod é `{}` = sem ajuste → null).
          signal_modifiers: ajusteDoJson(signal_modifiers),
          coberto_de: dono !== null && dono !== baseId ? dono : null,
        };
      });
    },
  });
}
