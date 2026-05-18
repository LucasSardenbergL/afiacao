import { useMemo } from 'react';
import { useMyCarteiraScores } from './useMyCarteiraScores';

export interface AgendaItem {
  customer_user_id: string;
  priority_score: number;
  health_class: string | null;
  agenda_type: 'risco' | 'expansao' | 'follow_up';
}

/**
 * Top N clientes da carteira priorizados por priority_score, com tipo de ação
 * derivado dos scores existentes:
 * - 'risco' se churn_risk > 0.5 ou health_class crítico/atenção
 * - 'expansao' se expansion_score > 0.5
 * - 'follow_up' default
 */
export function useMyAgendaToday(limit = 10) {
  const { data, isLoading } = useMyCarteiraScores();

  const agenda: AgendaItem[] = useMemo(() => {
    if (!data) return [];
    return data.slice(0, limit).map((s) => {
      let agenda_type: AgendaItem['agenda_type'] = 'follow_up';
      const churn = s.churn_risk ?? 0;
      const expansion = s.expansion_score ?? 0;
      if (churn > 0.5 || s.health_class === 'critico' || s.health_class === 'atencao') {
        agenda_type = 'risco';
      } else if (expansion > 0.5) {
        agenda_type = 'expansao';
      }
      return {
        customer_user_id: s.customer_user_id,
        priority_score: s.priority_score ?? 0,
        health_class: s.health_class,
        agenda_type,
      };
    });
  }, [data, limit]);

  return { agenda, isLoading };
}
