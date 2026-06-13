import type { KbExtractedSpec } from '@/lib/knowledge-base/specs-types';

/** Campos que pesam na recomendação de venda — o que vale buscar com a fábrica. Ajustável. */
export const CAMPOS_IMPORTANTES = [
  'rendimento_m2_por_litro','catalisador_codigo','catalisador_proporcao_pct','demaos_recomendadas',
  'validade_dias','pot_life_horas','diluente_codigo','substrato','solidos_pct','dureza',
] as const;

function vazio(v: unknown): boolean {
  return v == null || (Array.isArray(v) && v.length === 0) || v === '';
}

/** Campos importantes vazios OU sinalizados em extraction_gaps. */
export function camposFaltantes(spec: Partial<KbExtractedSpec>): string[] {
  const gaps = new Set((spec.extraction_gaps ?? []) as string[]);
  return CAMPOS_IMPORTANTES.filter((c) => vazio(spec[c]) || gaps.has(c));
}

export interface CompletudeProduto { product_code: string; product_name: string; faltantes: string[]; }

/** Por produto, os campos importantes faltando — ordenado por nº de faltantes desc (mais incompletos primeiro). */
export function relatorioCompletude(
  specs: (Partial<KbExtractedSpec> & { product_code: string; product_name: string })[],
): CompletudeProduto[] {
  return specs
    .map((s) => ({ product_code: s.product_code, product_name: s.product_name, faltantes: camposFaltantes(s) }))
    .sort((a, b) => b.faltantes.length - a.faltantes.length);
}
