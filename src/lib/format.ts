/**
 * Pequenos helpers de formatação compartilhados.
 *
 * IMPORTANTE: máscara de documento existe para LGPD — nunca logue CPF/CNPJ
 * inteiro em logs de aplicação. Use `maskDocument()` antes de passar para o
 * logger.
 */

/**
 * Mascara um CPF/CNPJ preservando os 4 primeiros dígitos e os 2 últimos.
 * Útil para logs e analytics: permite identificar aproximadamente o cliente
 * sem expor o documento completo.
 *
 * @example
 *   maskDocument('123.456.789-00') → '1234***00'
 *   maskDocument('12.345.678/0001-99') → '1234***99'
 *   maskDocument('123') → '***'
 *   maskDocument('') → '***'
 */
export function maskDocument(doc: string | null | undefined): string {
  if (!doc) return '***';
  const clean = doc.replace(/\D/g, '');
  if (clean.length < 6) return '***';
  return clean.slice(0, 4) + '***' + clean.slice(-2);
}
