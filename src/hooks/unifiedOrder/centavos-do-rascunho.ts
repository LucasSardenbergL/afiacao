import { emCentavos } from '@/lib/pricing/centavos';

/**
 * Centavos na RESTAURAÇÃO do rascunho (PR 2.4). O carrinho volta do localStorage literal, então um
 * rascunho salvo antes desta regra traz `unit_price` com 3-4 casas (o último praticado cru do Omie,
 * ou uma edição manual). Aqui o preço do produto comum volta ao centavo — o MESMO arredondamento do
 * nascimento (`precoPartida`) e da edição (`updateProductPrice`).
 *
 * `precoNascimento` é arredondado junto, e pela mesma função: um item que o vendedor não editou
 * (`unit_price === precoNascimento`) continua igual e a reprecificação da fronteira segue podendo corrigi-lo.
 *
 * Tint fica intocado: já nasce em centavos pela regra própria (`lib/tint`), e uma 2ª passada divergiria.
 * Valor não numérico fica como veio — o `priceGuard` barra o envio (ausente ≠ zero).
 */
export function centavosDoRascunho(cart: unknown[]): unknown[] {
  return cart.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const it = item as Record<string, unknown>;
    if (it.type !== 'product' || it.tint_cor_id || it.tint_formula_id) return item;
    const out: Record<string, unknown> = { ...it };
    if (typeof it.unit_price === 'number' && Number.isFinite(it.unit_price)) out.unit_price = emCentavos(it.unit_price);
    if (typeof it.precoNascimento === 'number' && Number.isFinite(it.precoNascimento)) {
      out.precoNascimento = emCentavos(it.precoNascimento);
    }
    return out;
  });
}
