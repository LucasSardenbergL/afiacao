/**
 * Converte um número digitado à mão (pt-BR ou en) para `number`, ou `null` se ilegível.
 *
 * Regra: se houver vírgula, ela é o separador DECIMAL e os pontos são milhar
 * (`"1.234,56"` → `1234.56`); sem vírgula, o ponto é o separador decimal
 * (`"12.5"` → `12.5`). Lixo/vazio → `null` (nunca fabrica zero — money-path).
 *
 * Existe porque `parseFloat("12,5")` = 12 (engole a vírgula do teclado decimal pt-BR),
 * transformando 12,50 em 1250 no input de preço do pedido.
 */
export function parseDecimalBR(input: string): number | null {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (s === '') return null;
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  }
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
