// Guard money-path da EDIÇÃO de pedido, sobre o shape OrderItem. A seleção dos itens a preço
// inválido (≤ 0 / NaN / ausente) é DELEGADA à primitiva canônica
// invalidPricedValorUnitarioIndices (src/services/orderSubmission/priceGuard.ts) — um único
// lar para a iteração sobre valor_unitario, em cima da única definição da decisão monetária
// (isInvalidProductPrice). Aqui só fixamos o shape (OrderItem) e a mensagem de "salvar".
// A edição de pedido só carrega produtos e tintas (não há serviço de afiação "a orçar"),
// então todo item é elegível ao guard.
import { invalidPricedValorUnitarioIndices } from '@/services/orderSubmission/priceGuard';
import { totalLinhaOuAusente } from '@/lib/format';
import type { OrderItem } from './types';

/** Índices dos itens com preço inválido (≤ 0 / NaN), preservando a ordem. A UI usa para destacar. */
export function invalidPricedOrderItemIndices(items: OrderItem[]): number[] {
  return invalidPricedValorUnitarioIndices(items);
}

/** Mensagem pt-BR pronta para toast, citando os itens inválidos (já filtrados). */
export function invalidOrderPriceMessage(invalidItems: OrderItem[]): string {
  const nomes = invalidItems.map((it) => it.descricao || it.codigo || 'item sem nome').join(', ');
  return `Defina um preço maior que zero antes de salvar. Itens com preço inválido: ${nomes}.`;
}

/**
 * Lê um número digitado em pt-BR. `null` = não dá para ler (vazio, lixo, negativo, ∞).
 *  - Com vírgula, ela é o decimal e o ponto só vale como milhar BEM FORMADO: "1.234,56" → 1234.56.
 *    Ponto fora de grupo de 3 é recusado ANTES de ser apagado: "1,250.00" (planilha em inglês) e
 *    "12.5,0" não viram 1,25 nem 125 (Codex, revisão do diff, 2026-11-25).
 *  - Sem vírgula, o ponto é o decimal: "12.5" → 12.5. MAS "1.234" / "1.250" (ponto + exatamente
 *    3 dígitos) é ambíguo entre milhar e fração — recusado: o vendedor escreve 1234 ou 1,234.
 *  - Separador no fim ("12," / "12.") lê o que veio antes — o CAMPO guarda o texto cru, então o
 *    vendedor continua digitando o centavo. Era exatamente isso que o `Number(texto)` quebrava:
 *    "12." virava 12, o input re-renderizava "12" e o dígito seguinte formava 125 (P0, 2026-11-25).
 */
export function lerDecimalPtBr(texto: string): number | null {
  const t = texto.trim();
  if (t === '') return null;
  let normal: string;
  if (t.includes(',')) {
    const m = /^(\d{1,3}(?:\.\d{3})+|\d*),(\d*)$/.exec(t);
    if (!m || (m[1] === '' && m[2] === '')) return null;
    normal = `${m[1].replace(/\./g, '') || '0'}.${m[2]}`;
  } else {
    if (/^\d{1,3}(?:\.\d{3})+$/.test(t)) return null; // ambíguo: milhar ou fração
    if (!/^\d+(\.\d*)?$|^\.\d+$/.test(t)) return null;
    normal = t;
  }
  const n = Number(normal);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Índices dos itens com quantidade inválida (ausente, não finita, ≤ 0). O salvar recusa. */
export function invalidQuantityOrderItemIndices(items: OrderItem[]): number[] {
  return items.flatMap((it, i) => {
    const q = it.quantidade as number | null | undefined;
    return typeof q === 'number' && Number.isFinite(q) && q > 0 ? [] : [i];
  });
}

/**
 * Subtotal da edição, ou `null` se alguma linha não tem total apurável.
 * `valor_total` é OPCIONAL no jsonb (51 linhas sem ele em pedidos abertos, prod 2026-11-25):
 * somar `?? 0` gravava subtotal/total MENORES que a verdade. Sem `valor_total`, a linha vale
 * quantidade × preço (a mesma conta do `updateItem`); sem isso também, o total é indeterminado.
 */
/**
 * Centavos half-up na 2ª casa via TEXTO decimal — cópia da `centavos` do envio
 * (supabase/functions/omie-vendas-sync/revisao-credito.ts; a edge não é importável do front).
 * `Math.round(1.005 * 100)` dá 100 (ponto flutuante); aqui dá 101, como lá.
 */
function centavosDaLinha(x: number): number {
  // Acima de 1e15 o `toFixed` perde a casa do centavo (e de 1e21 vira notação exponencial).
  if (!Number.isFinite(x) || Math.abs(x) >= 1e15) return Number.NaN;
  if (x < 0) return -centavosDaLinha(-x);
  const [inteiro, frac] = x.toFixed(6).split('.');
  return Number(inteiro) * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
}

export function subtotalDaEdicao(items: OrderItem[]): number | null {
  let soma = 0;
  for (const it of items) {
    const linha = it.valor_total ?? totalLinhaOuAusente(it.quantidade, it.valor_unitario);
    if (linha === null || linha === undefined || !Number.isFinite(linha)) return null;
    // Centavo por LINHA, como a regra de crédito do envio (0,5 × 2,01 = 1,01 por linha).
    soma += centavosDaLinha(linha);
  }
  return Number.isFinite(soma) ? soma / 100 : null;
}
