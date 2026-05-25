import type { GapCliente } from './types';

/** Texto concreto do "por quê" do gap. */
export function buildPorQue(g: GapCliente): string {
  const pct = Math.round(g.confidence * 100);
  const lift = Math.round(g.lift * 10) / 10;
  return `Clientes com padrão de compra parecido também compram ${g.familia_faltante} — confiança ${pct}%, lift ${lift}, ${g.evidence_count} evidência(s).`;
}

/** Ordena gaps por força da evidência (confidence×lift), desempate por evidence_count. Não muta. */
export function rankGaps(gaps: GapCliente[]): GapCliente[] {
  return [...gaps].sort((a, b) => {
    const fa = a.confidence * a.lift;
    const fb = b.confidence * b.lift;
    if (fb !== fa) return fb - fa;
    return b.evidence_count - a.evidence_count;
  });
}
