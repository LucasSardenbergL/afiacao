import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useMyActiveCoverage } from '@/hooks/useCoverage';
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

/**
 * Busca farmer_client_scores da MINHA carteira (Opção A: farmer_id = dono).
 * Expande pra cobertura ativa: farmer_id IN [eu, ...donos que eu cubro agora].
 *
 * ⚠️ SEGURANÇA: o filtro por farmer_id aqui é display-only, NÃO é fronteira de
 * segurança — a RLS de farmer_client_scores é ampla (qualquer staff lê tudo).
 * A impersonação (effectiveUserId ≠ eu) é master-only (gate no ImpersonationContext)
 * e o master já lê tudo, então isto não abre vazamento novo. Endurecer a RLS dessa
 * tabela (master OR farmer_id=auth.uid() OR cobertura) é follow-up de segurança.
 */
export function useMyCarteiraScores() {
  const { user } = useAuth();
  const { isImpersonating, effectiveUserId } = useImpersonation();
  const { data: coverage } = useMyActiveCoverage();
  const coveredIds = (coverage ?? []).map((c) => c.covered_user_id);
  const ownerIds = isImpersonating && effectiveUserId ? [effectiveUserId] : (user ? [user.id, ...coveredIds] : []);
  const baseId = isImpersonating ? effectiveUserId : user?.id;

  return useQuery({
    queryKey: ['my-carteira-scores', isImpersonating ? `as:${effectiveUserId}` : user?.id, coveredIds.sort().join(',')],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<CarteiraScoreRow[]> => {
      if (!user) return [];

      const { data, error } = await supabase.from('farmer_client_scores')
        .select('customer_user_id, farmer_id, health_score, health_class, priority_score, churn_risk, expansion_score, recover_score, revenue_potential, days_since_last_purchase, avg_monthly_spend_180d, signal_modifiers, sales_history_status, last_signal_recalc_at')
        .in('farmer_id', ownerIds)
        .order('priority_score', { ascending: false })
        .limit(200);
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<CarteiraScoreRow & { farmer_id: string }>;
      // signal_modifiers é coluna jsonb (Json nos tipos gerados): asserção Json→ScoreAdjustment no boundary
      return rows.map(({ farmer_id, ...row }) => ({
        ...row,
        coberto_de: farmer_id !== baseId ? farmer_id : null,
      }));
    },
  });
}
