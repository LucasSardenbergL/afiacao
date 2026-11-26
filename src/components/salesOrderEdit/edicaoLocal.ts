// O que a edição grava num pedido do app que ainda NÃO tem PV no Omie (rascunho/orçamento).
// Antes o UPDATE gravava `subtotal` e `total` com o MESMO número: qualquer desconto ou frete do
// cabeçalho se perdia — inclusive ao salvar só uma observação (revisão Codex+Fable 2026-11-25, P0-5).
import type { OrderItem } from './types';

/** Campos do item que definem o pedido (o resto — `valor_total` recalculado, ids de UI — não muda o
 *  que se vende). Ordem incluída: reordenar não é "mesmos itens" para o jsonb que o Omie recebe. */
function chaveDoItem(i: OrderItem): string {
  return JSON.stringify([
    i.product_id ?? null,
    i.omie_codigo_produto ?? null,
    i.quantidade ?? null,
    i.valor_unitario ?? null,
    i.tint_cor_id ?? null,
    i.tint_formula_id ?? null,
    i.tint_price_source ?? null,
  ]);
}

export function mesmosItens(a: readonly OrderItem[], b: readonly OrderItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => chaveDoItem(item) === chaveDoItem(b[i]));
}

export type PatchDosValores =
  | { ok: true; valores: { items: OrderItem[]; subtotal: number; total: number } | null }
  | { ok: false; motivo: string };

/**
 * Valores que o UPDATE local grava. `valores: null` = não tocar em items/subtotal/total (só a
 * observação/parcela mudou). Itens mudaram: `total = subtotal` só quando o pedido não tinha ajuste
 * de cabeçalho; COM ajuste (total ≠ subtotal), recusa — R$ 100 → R$ 90 pode ser R$ 10 fixos ou 10%,
 * e escolher uma das leituras seria fabricar o líquido (Codex 2026-11-26). Medido em 2026-11-26: os
 * 2 pedidos sem PV da prod têm total = subtotal.
 */
export function valoresDaEdicaoLocal(input: {
  itensOriginais: readonly OrderItem[];
  itensNovos: OrderItem[];
  subtotalOriginal: number | null | undefined;
  totalOriginal: number | null | undefined;
  subtotalNovo: number | null;
}): PatchDosValores {
  if (mesmosItens(input.itensOriginais, input.itensNovos)) return { ok: true, valores: null };
  if (input.subtotalNovo === null || !Number.isFinite(input.subtotalNovo)) {
    return { ok: false, motivo: 'Não consegui calcular o total do pedido. Confira preço e quantidade dos itens.' };
  }
  const sub = Number(input.subtotalOriginal);
  const tot = Number(input.totalOriginal);
  if (input.subtotalOriginal == null || input.totalOriginal == null || !Number.isFinite(sub) || !Number.isFinite(tot)) {
    return { ok: false, motivo: 'O total gravado deste pedido está ilegível — não dá para recalcular sem perder um desconto ou frete.' };
  }
  if (Math.abs(tot - sub) >= 0.005) {
    return {
      ok: false,
      motivo: 'Este pedido tem desconto ou frete no total. Mudar os itens por aqui recalcularia o valor sem saber como o ajuste foi feito — refaça o orçamento ou ajuste no envio.',
    };
  }
  return { ok: true, valores: { items: input.itensNovos, subtotal: input.subtotalNovo, total: input.subtotalNovo } };
}
