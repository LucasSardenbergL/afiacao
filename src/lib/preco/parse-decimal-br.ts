/**
 * Converte um número digitado à mão (pt-BR ou en) para `number`, ou `null` se ilegível
 * OU ambíguo. Nunca fabrica um número errado a partir de entrada ambígua — money-path:
 * um preço silenciosamente errado é pior que exigir o usuário redigitar.
 *
 * Regras:
 *  - Ambos separadores presentes: o ÚLTIMO é o decimal, o outro é milhar (grupos de 3).
 *    `"1.234,56"` → 1234.56 (pt-BR) · `"1,234.56"` → 1234.56 (en-US).
 *  - Só vírgula: uma vírgula = decimal pt-BR (`"12,5"`→12.5); várias = milhar (`"1,234,567"`→1234567).
 *  - Só ponto: 1-2 casas ou inteiro "0…" = decimal (`"12.5"`,`"0.999"`); vários pontos = milhar pt-BR.
 *    Exatamente 3 casas com inteiro que parece grupo de milhar (`"1.234"`) é AMBÍGUO → `null`.
 *  - Agrupamento mal formado (grupos ≠ 3 dígitos) → `null`.
 *
 * Existe porque `parseFloat("12,5")` = 12 (engole a vírgula do teclado decimal pt-BR),
 * transformando 12,50 em 1250 no input de preço do pedido.
 */
export function parseDecimalBR(input: string): number | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s === '') return null;
  if (!/^-?[\d.,]+$/.test(s)) return null;

  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;

  const finish = (intPart: string, frac: string): number | null => {
    const norm = frac ? `${intPart}.${frac}` : intPart;
    if (!/^\d+(\.\d+)?$/.test(norm)) return null;
    const n = Number((neg ? '-' : '') + norm);
    return Number.isFinite(n) ? n : null;
  };
  // Agrupamento de milhar válido: primeiro grupo 1-3 dígitos, os demais exatamente 3.
  const validGrouping = (groups: string[]): boolean =>
    groups.length > 1 &&
    groups[0].length >= 1 && groups[0].length <= 3 &&
    groups.slice(1).every((g) => g.length === 3);

  const lastComma = body.lastIndexOf(',');
  const lastDot = body.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    const decSep = lastComma > lastDot ? ',' : '.';
    const grpSep = decSep === ',' ? '.' : ',';
    const parts = body.split(decSep);
    if (parts.length !== 2) return null; // 2+ separadores decimais = malformado
    const groups = parts[0].split(grpSep);
    if (!validGrouping(groups)) return null;
    return finish(groups.join(''), parts[1]);
  }

  if (lastComma >= 0) {
    const parts = body.split(',');
    if (parts.length === 2) return finish(parts[0], parts[1]);
    return validGrouping(parts) ? finish(parts.join(''), '') : null;
  }

  if (lastDot >= 0) {
    const parts = body.split('.');
    if (parts.length === 2) {
      const [intP, frac] = parts;
      // "1.234" (3 casas + inteiro 1-3 díg sem zero à esquerda) é ambíguo: 1234 ou 1.234 → null.
      if (frac.length === 3 && /^[1-9]\d{0,2}$/.test(intP)) return null;
      return finish(intP, frac);
    }
    return validGrouping(parts) ? finish(parts.join(''), '') : null;
  }

  return finish(body, '');
}
