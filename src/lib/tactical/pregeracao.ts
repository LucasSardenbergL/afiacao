/** Pré-geração noturna do plano tático: gate de eficiência + seleção dos prioritários.
 *  Oráculo puro — a edge tactical-plans-batch (Deno) replica esta lógica inline
 *  (front e edge não compartilham módulo; este helper é a fonte da verdade testada). */
export const PROFIT_PER_HOUR_THRESHOLD = 50; // R$/h — espelha useTacticalPlan.ts:198
const AVG_CALL_MINUTES = 15;

export interface ScoreParaSelecao {
  customerUserId: string;
  priorityScore: number;
  revenuePotential: number;
  avgSpend: number;
  marginPct: number;
}

/** R$/h estimado por ligação. Espelha useTacticalPlan.checkEfficiency (linhas 313-318). */
export function profitPerHora(
  s: Pick<ScoreParaSelecao, 'revenuePotential' | 'avgSpend' | 'marginPct'>,
): number {
  const base = s.revenuePotential > 0 ? s.revenuePotential : s.avgSpend;
  const marginPerCall = base * (s.marginPct / 100) * 0.1;
  return marginPerCall / (AVG_CALL_MINUTES / 60);
}

/** Top-N por priorityScore desc, filtrando quem passa no gate de R$/h.
 *  Filtra ANTES de cortar: retorna os N de maior priority DENTRE OS ELEGÍVEIS. */
export function selecionarParaPregeracao(
  scores: ScoreParaSelecao[],
  topN: number,
): ScoreParaSelecao[] {
  return [...scores]
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .filter((s) => profitPerHora(s) >= PROFIT_PER_HOUR_THRESHOLD)
    .slice(0, topN);
}
