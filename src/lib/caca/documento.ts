/**
 * Utilitários de normalização de documento (CNPJ / CPF).
 * Helper PURO — sem IO, sem imports externos.
 */

/**
 * Normaliza um documento para só dígitos.
 * Exemplos:
 *   "12.345.678/0001-90" → "12345678000190"
 *   null / "" → ""
 *   "abc" → ""
 */
export function normalizarDocumento(doc: string | null): string {
  if (!doc) return '';
  return doc.replace(/\D/g, '');
}
