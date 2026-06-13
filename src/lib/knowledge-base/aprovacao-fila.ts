import type { KbExtractedSpec } from '@/lib/knowledge-base/specs-types';

/** Confiança mínima da extração pra entrar no "aprovar em lote" (decisão do founder). */
export const LIMIAR_AUTO_APROVACAO = 0.85;

/** Par (documentId, spec) retornado pela edge function kb-extract-specs após processar um PDF. */
export interface ResultadoExtracao {
  documentId: string;
  spec: KbExtractedSpec;
}

/**
 * Classifica um resultado de extração em dois estados:
 * - 'auto'    → confiança ≥ limiar E product_code preenchido (NOT NULL no banco).
 *               Pode entrar na aprovação em lote sem revisão manual.
 * - 'revisar' → confiança baixa, ausente, ou sem código de produto.
 *               Precisa de revisão antes de salvar.
 *
 * Nunca fabrica certeza: confiança null/undefined → 'revisar'.
 */
export function classificarExtracao(
  spec: KbExtractedSpec,
  limiar: number = LIMIAR_AUTO_APROVACAO,
): 'auto' | 'revisar' {
  // product_code é NOT NULL no banco — sem ele não é possível salvar
  if (!spec.product_code) return 'revisar';

  const conf = spec.extraction_confidence;

  // confiança ausente ou abaixo do limiar → revisão obrigatória
  if (conf == null || conf < limiar) return 'revisar';

  return 'auto';
}

/**
 * Particiona uma lista de extrações em dois grupos:
 * - auto    → aprovação em lote (alta confiança + código de produto)
 * - revisar → fila de revisão manual
 *
 * Preserva a ordem original dentro de cada grupo.
 */
export function particionarResultados(
  resultados: ResultadoExtracao[],
  limiar: number = LIMIAR_AUTO_APROVACAO,
): { auto: ResultadoExtracao[]; revisar: ResultadoExtracao[] } {
  const auto: ResultadoExtracao[] = [];
  const revisar: ResultadoExtracao[] = [];

  for (const r of resultados) {
    (classificarExtracao(r.spec, limiar) === 'auto' ? auto : revisar).push(r);
  }

  return { auto, revisar };
}
