import { useMemo } from 'react';
import { useMyCarteiraScores } from './useMyCarteiraScores';
import type { ScoreAdjustment, SignalModifier } from '@/lib/scoring/types';

export interface AgendaItem {
  customer_user_id: string;
  priority_score: number;
  health_class: string | null;
  agenda_type: 'risco' | 'expansao' | 'follow_up';
  topModifier: SignalModifier | null;
  signalsCount: number;
}

/**
 * Top N clientes da carteira priorizados por priority_score, com tipo de ação
 * derivado dos scores existentes:
 * - 'risco' se churn_risk > 0.5 ou health_class crítico/atenção
 * - 'expansao' se expansion_score > 0.5
 * - 'follow_up' default
 *
 * Também extrai topModifier do signal_modifiers pra UI mostrar badge com
 * sinal dominante (maior |delta * decayedWeight|).
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
      const mods = s.signal_modifiers;
      const topModifier = mods ? pickTopModifier(mods) : null;
      const signalsCount = mods
        ? mods.breakdown.churn.length +
          mods.breakdown.expansion.length +
          mods.breakdown.health.length +
          mods.breakdown.eff.length
        : 0;
      return {
        customer_user_id: s.customer_user_id,
        priority_score: s.priority_score ?? 0,
        health_class: s.health_class,
        agenda_type,
        topModifier,
        signalsCount,
      };
    });
  }, [data, limit]);

  return { agenda, isLoading };
}

function pickTopModifier(adj: ScoreAdjustment): SignalModifier | null {
  const all = [
    ...adj.breakdown.churn,
    ...adj.breakdown.expansion,
    ...adj.breakdown.health,
    ...adj.breakdown.eff,
  ];
  if (all.length === 0) return null;
  return all.reduce((top, cur) => {
    const topMag = Math.abs(top.delta * top.decayedWeight);
    const curMag = Math.abs(cur.delta * cur.decayedWeight);
    return curMag > topMag ? cur : top;
  });
}
