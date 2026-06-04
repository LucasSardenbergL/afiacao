import type { AcaoSugerida, CategoriaAcao } from './types';

// menor = mais alta na fila. A ordem é o guardrail: incerto nunca atropela SLA/certo.
const ORDEM_CATEGORIA: Record<CategoriaAcao, number> = {
  prazo: 0, certo: 1, esperado: 2, risco: 3,
};

/** Compara prioridade: categoria, depois valorEsperado desc (null por último), depois score desc. */
function comparar(a: AcaoSugerida, b: AcaoSugerida): number {
  const dc = ORDEM_CATEGORIA[a.categoria] - ORDEM_CATEGORIA[b.categoria];
  if (dc !== 0) return dc;
  const va = a.valorEsperado, vb = b.valorEsperado;
  if (va != null && vb != null && va !== vb) return vb - va;
  if (va == null && vb != null) return 1;
  if (va != null && vb == null) return -1;
  return b.score - a.score;
}

export function rankearFila(acoes: AcaoSugerida[]): AcaoSugerida[] {
  return [...acoes].sort(comparar);
}

/** Mantém, por dedupeKey, só a ação de maior prioridade. */
export function dedupe(acoes: AcaoSugerida[]): AcaoSugerida[] {
  const melhor = new Map<string, AcaoSugerida>();
  for (const a of acoes) {
    const atual = melhor.get(a.dedupeKey);
    if (!atual || comparar(a, atual) < 0) melhor.set(a.dedupeKey, a);
  }
  return [...melhor.values()];
}
