import { useMemo } from 'react';
import { useMyCarteiraScores } from './useMyCarteiraScores';
import { buildAgendaItems, type AgendaItem } from '@/lib/scoring/agenda';

export type { AgendaItem };

/**
 * Top N clientes da carteira priorizados por prioridade EFETIVA (base do
 * calculate-scores + nudge dos sinais de call), com tipo de ação derivado
 * dos scores (escala 0..100).
 *
 * A modulação de prioridade pelos sinais acontece aqui (read-time): a coluna
 * priority_score continua sendo a base rica do calculate-scores; o
 * scoring-recalc só persiste signal_modifiers. Ver src/lib/scoring/agenda.ts.
 */
export function useMyAgendaToday(limit = 10) {
  const { data, isLoading } = useMyCarteiraScores();

  const agenda: AgendaItem[] = useMemo(
    () => (data ? buildAgendaItems(data, limit) : []),
    [data, limit],
  );

  return { agenda, isLoading };
}
