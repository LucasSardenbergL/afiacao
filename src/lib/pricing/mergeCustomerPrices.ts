/**
 * Guard money-path de preço unitário: finito e > 0 (pega 0, negativo, NaN, ±Infinity e não-número).
 * Consumidores: a proposta de cotação do WhatsApp (`src/lib/whatsapp/proposta-cotacao.ts`,
 * `src/services/whatsappProposta/enviarProposta.ts`).
 *
 * HISTÓRICO (o nome do arquivo ficou): até 2026-09-30 este módulo também tinha `mergeCustomerPrices`
 * — o merge "order_items vence, Omie preenche gap" que a edge `analyze-unified-order` aplicava aos
 * itens da IA, espelhado VERBATIM nela (bloco MIRROR) e atestado pela canária
 * `praticado-vence-omie-v1`. A edge deixou de precificar (a IA só IDENTIFICA; o item nasce pelo
 * `precoPartida` do front, ver `src/hooks/unifiedOrder/nascimento-item.ts`), o merge ficou sem
 * nenhum chamador e foi APOSENTADO — não migrado: um merge de preço vivo e sem consumidor é um 2º
 * decisor à espera de alguém religá-lo. O arquivo não foi renomeado porque os imports do WhatsApp
 * e a baseline de fronteiras de módulo (`src/lib/modulos/fronteiras-baseline.ts`) o citam pelo caminho.
 */
export function isValidUnitPrice(p: unknown): p is number {
  return typeof p === "number" && Number.isFinite(p) && p > 0;
}
