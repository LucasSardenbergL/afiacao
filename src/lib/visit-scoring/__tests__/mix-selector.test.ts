import { describe, it, expect } from 'vitest';
import { pickDailyMix } from '../mix-selector';
import type { MissionResult, MissionType, VisitScore } from '../types';

// `pickDailyMix` só lê `primary_mission`/`visit_score`/`customer_user_id` (não `.scores`
// diretamente) — as fixtures abaixo só precisam do shape novo (`MissionResult`) para tipar,
// sem insumo ausente relevante ao que este módulo testa.
function mkScore(id: string, mission: MissionType, score: number): VisitScore {
  const missao = (m: MissionType): MissionResult => ({
    score: m === mission ? score : 0,
    insumosAusentes: [],
  });
  return {
    customer_user_id: id,
    scores: {
      recuperacao: missao('recuperacao'),
      expansao: missao('expansao'),
      relacionamento: missao('relacionamento'),
      prospeccao: missao('prospeccao'),
    },
    visit_score: score,
    primary_mission: mission,
    city: 'Belo Horizonte',
    neighborhood: null,
    days_since_last_visit: null,
    insumos_ausentes: [],
  };
}

describe('pickDailyMix', () => {
  it('lista vazia retorna array vazio', () => {
    expect(pickDailyMix([], 6)).toEqual([]);
  });

  it('target maior que candidatos retorna todos', () => {
    const cand = [mkScore('a', 'expansao', 90), mkScore('b', 'recuperacao', 80)];
    expect(pickDailyMix(cand, 6)).toHaveLength(2);
  });

  it('respeita maxFractionPerMission 50% num target de 6 (cap 3 por missão)', () => {
    const cand = Array.from({ length: 10 }, (_, i) =>
      mkScore(`c${i}`, 'expansao', 100 - i)
    );
    const result = pickDailyMix(cand, 6, 0.5);
    expect(result).toHaveLength(6);
  });

  it('preserva ordem de visit_score dentro de cada missão', () => {
    const cand = [
      mkScore('a', 'expansao', 80),
      mkScore('b', 'recuperacao', 90),
      mkScore('c', 'expansao', 70),
      mkScore('d', 'relacionamento', 60),
    ];
    const result = pickDailyMix(cand, 4, 0.5);
    const ids = result.map(r => r.customer_user_id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'));
  });

  it('garante diversidade quando top é dominado por uma missão', () => {
    const cand = [
      ...Array.from({ length: 5 }, (_, i) => mkScore(`e${i}`, 'expansao', 100 - i)),
      ...Array.from({ length: 5 }, (_, i) => mkScore(`r${i}`, 'recuperacao', 80 - i)),
    ];
    const result = pickDailyMix(cand, 6, 0.5);
    const expansionCount = result.filter(r => r.primary_mission === 'expansao').length;
    const recuperacaoCount = result.filter(r => r.primary_mission === 'recuperacao').length;
    expect(expansionCount).toBeLessThanOrEqual(3);
    expect(recuperacaoCount).toBeGreaterThanOrEqual(3);
  });

  it('não duplica candidatos no pass 2', () => {
    const cand = Array.from({ length: 4 }, (_, i) =>
      mkScore(`c${i}`, 'expansao', 100 - i)
    );
    const result = pickDailyMix(cand, 6, 0.5);
    const ids = result.map(r => r.customer_user_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
