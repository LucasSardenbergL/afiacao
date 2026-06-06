/**
 * Construção do perfil estatístico dos melhores clientes via lift.
 *
 * lift(v, dim) = freq(v | melhores) / freq(v | base)
 *
 * Tratamento de divisão por zero:
 *   Se freq(v | base) == 0 (valor presente só nos melhores, ausente na base), o lift
 *   tenderia a infinito. Em vez disso, retornamos o `tetoLift` — sinaliza alta
 *   relevância (raro na base, prevalente nos melhores) sem explodir o score. O
 *   `suporteMin` (>= N ocorrências nos melhores) já filtra ruído antes de chegar aqui.
 *
 * Helper PURO — sem IO, sem imports externos.
 */

import type { MelhorCliente, PerfilMelhores } from './types';

interface PerfilOpts {
  /** Mínimo de ocorrências nos melhores para o lift ser calculado (default 3). */
  suporteMin?: number;
  /** Teto de lift para evitar que um valor raro domine (default 5). */
  tetoLift?: number;
}

/** Conta frequência de cada valor numa lista (ignora null/undefined). */
function contarFreqs(valores: (string | null)[]): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const v of valores) {
    if (v === null || v === undefined) continue;
    mapa.set(v, (mapa.get(v) ?? 0) + 1);
  }
  return mapa;
}

/** Calcula mediana de um array de números. */
function mediana(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const ordenado = [...nums].sort((a, b) => a - b);
  const meio = Math.floor(ordenado.length / 2);
  if (ordenado.length % 2 === 1) {
    return ordenado[meio];
  }
  return (ordenado[meio - 1] + ordenado[meio]) / 2;
}

/**
 * Constrói o perfil de lifts dos melhores clientes em relação à base.
 *
 * @param melhores  Lista de melhores clientes (fonte dos lifts).
 * @param base      População de referência (todos os clientes ativos ou carteira total).
 * @param opts      Opções de suporte mínimo e teto de lift.
 */
export function perfilPorLift(
  melhores: MelhorCliente[],
  base: Array<{ cidadeUf: string | null; ramo: string | null; familias: string[] }>,
  opts: PerfilOpts = {},
): PerfilMelhores {
  const suporteMin = opts.suporteMin ?? 3;
  const tetoLift = opts.tetoLift ?? 5;

  const nMelhores = melhores.length;
  const nBase = base.length;

  // Frequências nos melhores (contagem por valor)
  const regiaoMelhores = contarFreqs(melhores.map((m) => m.cidadeUf));
  const ramoMelhores = contarFreqs(melhores.map((m) => m.ramo));
  const familiaMelhores = contarFreqs(melhores.flatMap((m) => m.familias));

  // Frequências na base
  const regiaoBase = contarFreqs(base.map((b) => b.cidadeUf));
  const ramoBase = contarFreqs(base.map((b) => b.ramo));
  const familiaBase = contarFreqs(base.flatMap((b) => b.familias));

  /** Calcula o lift de um valor em uma dimensão. */
  function calcLift(
    valor: string,
    contMelhores: Map<string, number>,
    contBase: Map<string, number>,
    totalMelhores: number,
    totalBase: number,
  ): number {
    const nM = contMelhores.get(valor) ?? 0;
    // Suporte insuficiente nos melhores → lift neutro
    if (nM < suporteMin) return 1;

    const freqM = nM / (totalMelhores || 1);
    const nB = contBase.get(valor) ?? 0;

    // Valor não existe na base → excluímos (não calculável de forma significativa)
    // Retornamos o teto como sinal de "aparece só nos melhores"
    if (nB === 0 || totalBase === 0) return tetoLift;

    const freqB = nB / totalBase;
    return Math.min(freqM / freqB, tetoLift);
  }

  // Construção dos lifts
  const regiaoLift: Record<string, number> = {};
  for (const valor of regiaoMelhores.keys()) {
    regiaoLift[valor] = calcLift(valor, regiaoMelhores, regiaoBase, nMelhores, nBase);
  }

  const ramoLift: Record<string, number> = {};
  for (const valor of ramoMelhores.keys()) {
    ramoLift[valor] = calcLift(valor, ramoMelhores, ramoBase, nMelhores, nBase);
  }

  // Total de ocorrências de famílias (cada cliente pode ter múltiplas)
  const totalFamiliaMelhores = melhores.reduce((acc, m) => acc + m.familias.length, 0);
  const totalFamiliaBase = base.reduce((acc, b) => acc + b.familias.length, 0);

  const familiaLift: Record<string, number> = {};
  for (const valor of familiaMelhores.keys()) {
    familiaLift[valor] = calcLift(
      valor,
      familiaMelhores,
      familiaBase,
      totalFamiliaMelhores,
      totalFamiliaBase,
    );
  }

  // Ticket mediano (ignora null)
  const tickets = melhores
    .map((m) => m.ticketFaixa)
    .filter((t): t is number => t !== null);

  return {
    regiaoLift,
    ramoLift,
    familiaLift,
    ticketMediano: mediana(tickets),
    nMelhores,
  };
}
