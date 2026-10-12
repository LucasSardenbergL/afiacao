// Quantidades do picking em MILIONÉSIMOS inteiros: o servidor guarda `numeric` com até 6 casas
// (picking_v2_motivo_invalido) e compara exato; em ponto flutuante 0,1 + 0,2 ≠ 0,3 e a linha de
// 0,3 L nunca fecharia na tela (Codex Fase 1 P2-10).
const ESCALA = 1_000_000;

/** Número → milionésimos inteiros (arredonda o ruído de ponto flutuante, não a 7ª casa real). */
export function micro(x: number): number {
  return Math.round(x * ESCALA);
}

export function deMicro(m: number): number {
  return m / ESCALA;
}

/**
 * A quantidade manual cabe em 6 casas? Confere a representação que vai no JSON (a mesma que o
 * `numeric` do servidor recebe): `0,9999996` seria aceito lá e arredondado aqui, escondendo um
 * resto impossível de lançar (Codex Fase 1 r2). Só positiva e finita.
 */
export function quantidadeRepresentavel(x: number): boolean {
  return x > 0 && /^\d+(\.\d{1,6})?$/.test(JSON.stringify(x));
}
