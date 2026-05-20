/**
 * Seleciona mix diário com diversidade entre missões.
 *
 * Pass 1: itera candidatos por visit_score DESC, respeitando cap por missão
 *         (default: 50% do target).
 * Pass 2: se não atingiu target, relaxa cap e preenche com restantes.
 *
 * Garante:
 * - Sem duplicatas
 * - Sem ultrapassar targetCount
 * - Mantém ordem de visit_score dentro de cada missão
 */

import type { MissionType, VisitScore } from './types';

export function pickDailyMix(
  candidates: VisitScore[],
  targetCount = 6,
  maxFractionPerMission = 0.5,
): VisitScore[] {
  const selected: VisitScore[] = [];
  const missionCount: Record<MissionType, number> = {
    recuperacao: 0,
    expansao: 0,
    relacionamento: 0,
    prospeccao: 0,
  };
  const maxPerMission = Math.ceil(targetCount * maxFractionPerMission);

  for (const c of candidates) {
    if (selected.length >= targetCount) break;
    if (missionCount[c.primary_mission] >= maxPerMission) continue;
    selected.push(c);
    missionCount[c.primary_mission]++;
  }

  if (selected.length < targetCount) {
    const selectedIds = new Set(selected.map(s => s.customer_user_id));
    for (const c of candidates) {
      if (selected.length >= targetCount) break;
      if (selectedIds.has(c.customer_user_id)) continue;
      selected.push(c);
      selectedIds.add(c.customer_user_id);
    }
  }

  return selected;
}
