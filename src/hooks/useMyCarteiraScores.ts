import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
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
}

/**
 * Busca farmer_client_scores filtrado pelo vendedor logado.
 * Já está pronto na infra existente — só consumimos.
 */
export function useMyCarteiraScores() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-carteira-scores', user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<CarteiraScoreRow[]> => {
      if (!user) return [];
       
      const { data, error } = await supabase.from('farmer_client_scores')
        .select('customer_user_id, health_score, health_class, priority_score, churn_risk, expansion_score, recover_score, revenue_potential, days_since_last_purchase, avg_monthly_spend_180d, signal_modifiers, last_signal_recalc_at')
        .eq('farmer_id', user.id)
        .order('priority_score', { ascending: false })
        .limit(200);
      if (error) throw error;
      // signal_modifiers é coluna jsonb (Json nos tipos gerados): asserção Json→ScoreAdjustment no boundary
      return (data ?? []) as unknown as CarteiraScoreRow[];
    },
  });
}
