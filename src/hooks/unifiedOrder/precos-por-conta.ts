/**
 * Preço-do-cliente (último praticado) separado POR CONTA Omie.
 *
 * Oben e Colacor são contas Omie SEPARADAS cujo `omie_codigo_produto` pode
 * COLIDIR numericamente. Achatar os dois espaços de chave num `Record` só (e
 * injetar nas 2 contas) faz o preço praticado numa conta vazar no produto de
 * mesmo código da outra — bug money-path (preço errado na tela do vendedor) e,
 * dentro do mesmo mapa, sobrescrita NÃO-determinística (vence quem a query
 * devolver por último). O `product_id` (uuid de `omie_products`) JÁ é
 * account-aware; este helper preserva isso, dividindo em um mapa por conta.
 *
 * Espelha a normalização de conta do selo (`montarSelosVendaAssistida`):
 * `account` minúsculo. Puro/testável — sem React/supabase.
 */

export interface PrecosLocaisPorConta {
  oben: Record<number, number>;
  colacor: Record<number, number>;
}

/** Linha de `omie_products` projetada para resolver a conta de cada preço. */
export interface ProductAccountMapping {
  id: string;
  omie_codigo_produto: number;
  account: string | null;
}

export function montarPrecosLocaisPorConta(
  /** uuid de omie_products → preço praticado (já deduplicado por product_id). */
  precoPorProductId: Record<string, number>,
  productMappings: ProductAccountMapping[],
): PrecosLocaisPorConta {
  // omie_products tem UNIQUE(omie_codigo_produto, account) — logo, por conta, cada
  // código tem no máximo 1 product_id: a atribuição "último vence" abaixo nunca
  // colide de fato dentro da mesma conta (o constraint garante a determinação).
  const out: PrecosLocaisPorConta = { oben: {}, colacor: {} };
  for (const pm of productMappings) {
    const price = precoPorProductId[pm.id];
    // Money-path: ausente/0/negativo/NaN/Infinity NUNCA vira preço (não fabricar).
    // Mesmo invariante do guard de fronteira: !(Number.isFinite(p) && p > 0).
    if (!(Number.isFinite(price) && price > 0)) continue;
    const conta = (pm.account ?? '').trim().toLowerCase();
    if (conta === 'oben') out.oben[pm.omie_codigo_produto] = price;
    else if (conta === 'colacor') out.colacor[pm.omie_codigo_produto] = price;
    // Conta desconhecida/null (ex.: 'colacor_sc') → descartada de propósito: o
    // wizard só vende Oben e Colacor; injetar em qualquer uma vazaria preço.
  }
  return out;
}
