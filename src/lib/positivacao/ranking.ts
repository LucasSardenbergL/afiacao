import type { ClienteAPositivar } from './types';

/** Ordena candidatos "a positivar" por prioridade comercial (não muta a entrada). */
export function rankAPositivar(candidatos: ClienteAPositivar[]): ClienteAPositivar[] {
  return [...candidatos].sort((a, b) => {
    const ps = (b.priority_score ?? 0) - (a.priority_score ?? 0);
    if (ps !== 0) return ps;
    const rp = (b.revenue_potential ?? 0) - (a.revenue_potential ?? 0);
    if (rp !== 0) return rp;
    return (b.churn_risk ?? 0) - (a.churn_risk ?? 0);
  });
}
