export const LINHAS_INPUT = ['receita_bruta','deducoes','cmv','despesas_operacionais','despesas_administrativas','despesas_comerciais','despesas_financeiras','receitas_financeiras','outras_receitas','outras_despesas','impostos'] as const;
export type LinhaInput = typeof LINHAS_INPUT[number];
export const LINHAS_RECEITA = new Set<string>(['receita_bruta','receitas_financeiras','outras_receitas']);
export const LINHAS_DESPESA_FIXA = new Set<string>(['despesas_operacionais','despesas_administrativas','despesas_comerciais']);
export const LINHAS_FINANCEIRA = new Set<string>(['receitas_financeiras','despesas_financeiras']);
export const LINHAS_DERIV_FAVORAVEL_CIMA = new Set<string>(['receita_liquida','lucro_bruto','resultado_operacional','resultado_antes_impostos','resultado_liquido']);
export type MesDRE = { mes: number } & Partial<Record<LinhaInput, number>>;
export type DerivadasResult = { receita_liquida: number; lucro_bruto: number; resultado_operacional: number; resultado_antes_impostos: number; resultado_liquido: number };

/**
 * Retorna a lista de meses fechados (com dados completos) para um dado ano.
 * - Ano passado: [1..12]
 * - Ano corrente: [1..mesAtual-1] (mês em curso fica fora)
 * - Ano futuro: []
 */
export function mesesFechados(ano: number, hoje: Date = new Date()): number[] {
  const anoAtual = hoje.getFullYear();
  if (ano < anoAtual) {
    return [1,2,3,4,5,6,7,8,9,10,11,12];
  }
  if (ano > anoAtual) {
    return [];
  }
  // ano === anoAtual: getMonth() é 0-based, então maio = 4 → fechados = [1,2,3,4]
  const mesCorrente = hoje.getMonth(); // 0-based: jan=0, mai=4
  return Array.from({ length: mesCorrente }, (_, i) => i + 1);
}

/**
 * Razão YTD: Σnum / Σden.
 * Retorna null se Σden <= 0 ou se arrays vazios.
 */
export function razaoYTD(num: number[], den: number[]): number | null {
  const s = den.reduce((acc, v) => acc + v, 0);
  if (s <= 0) return null;
  const n = num.reduce((acc, v) => acc + v, 0);
  return n / s;
}

/**
 * Fator de tendência YTD: Σreceita_bruta(atual) / Σreceita_bruta(anoAnt),
 * apenas nos meses em `fechados`, com cap [0.5, 2.0].
 * Retorna null se a base do ano anterior for <= 0.
 */
export function fatorTendenciaYTD(
  atual: MesDRE[],
  anoAnt: MesDRE[],
  fechados: number[]
): number | null {
  const fechadosSet = new Set(fechados);

  const somaAtual = atual
    .filter(m => fechadosSet.has(m.mes))
    .reduce((acc, m) => acc + (m.receita_bruta ?? 0), 0);

  const somaAnt = anoAnt
    .filter(m => fechadosSet.has(m.mes))
    .reduce((acc, m) => acc + (m.receita_bruta ?? 0), 0);

  if (somaAnt <= 0) return null;

  return Math.min(2.0, Math.max(0.5, somaAtual / somaAnt));
}

/**
 * Deriva as linhas calculadas do DRE a partir das linhas de input.
 * Campos omitidos são tratados como 0.
 */
export function derivarLinhas(i: Partial<Record<LinhaInput, number>>): DerivadasResult {
  const receita_bruta          = i.receita_bruta          ?? 0;
  const deducoes               = i.deducoes               ?? 0;
  const cmv                    = i.cmv                    ?? 0;
  const despesas_operacionais  = i.despesas_operacionais  ?? 0;
  const despesas_administrativas = i.despesas_administrativas ?? 0;
  const despesas_comerciais    = i.despesas_comerciais    ?? 0;
  const receitas_financeiras   = i.receitas_financeiras   ?? 0;
  const despesas_financeiras   = i.despesas_financeiras   ?? 0;
  const outras_receitas        = i.outras_receitas        ?? 0;
  const outras_despesas        = i.outras_despesas        ?? 0;
  const impostos               = i.impostos               ?? 0;

  const receita_liquida           = receita_bruta - deducoes;
  const lucro_bruto               = receita_liquida - cmv;
  const resultado_operacional     = lucro_bruto - despesas_operacionais - despesas_administrativas - despesas_comerciais;
  const resultado_antes_impostos  = resultado_operacional + receitas_financeiras - despesas_financeiras + outras_receitas - outras_despesas;
  const resultado_liquido         = resultado_antes_impostos - impostos;

  return {
    receita_liquida,
    lucro_bruto,
    resultado_operacional,
    resultado_antes_impostos,
    resultado_liquido,
  };
}
