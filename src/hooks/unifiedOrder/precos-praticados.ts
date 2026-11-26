/**
 * Último preço PRATICADO do cliente, por conta — a leitura que o Novo Pedido (`useCustomerSelection`)
 * e a edição de pedido (`useSalesOrderEdit`) fazem com a MESMA regra. Fonte de verdade: a RPC
 * `get_ultimos_precos_cliente` (lê `order_items`, ordenada por `order_date_kpi`); o mapeamento
 * product_id → (omie_codigo_produto, conta) separa as contas (códigos colidem entre Oben e Colacor —
 * `montarPrecosLocaisPorConta`).
 */
import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';
import { montarPrecosLocaisPorConta, type PrecosLocaisPorConta } from './precos-por-conta';

export type LinhaPrecoPraticado = { product_id: string; unit_price: number; ultimo_praticado_em?: string | null };

export const PRECOS_LOCAIS_VAZIOS: PrecosLocaisPorConta = { oben: {}, colacor: {}, datasOben: {}, datasColacor: {} };

/** Resolve as linhas da RPC em DOIS mapas account-aware (oben/colacor). Falha do mapeamento degrada
 *  para o preço de tabela (mapas vazios), com rastro — nunca R$ 0. */
export async function resolverPrecosLocaisPorConta(
  localPriceRows: LinhaPrecoPraticado[] | null,
  opcoes: { estrito?: boolean } = {},
): Promise<PrecosLocaisPorConta> {
  if (!localPriceRows || localPriceRows.length === 0) return { ...PRECOS_LOCAIS_VAZIOS };
  const localPricesByProduct: Record<string, number> = {};
  const datasByProduct: Record<string, string | null> = {};
  for (const row of localPriceRows) {
    // get_ultimos vem DISTINCT ON (product_id) ORDER BY data DESC → a 1ª linha por
    // produto é a mais recente; capturamos a data DELA junto com o preço.
    if (!localPricesByProduct[row.product_id]) {
      localPricesByProduct[row.product_id] = row.unit_price;
      datasByProduct[row.product_id] = row.ultimo_praticado_em ?? null;
    }
  }
  const productIds = Object.keys(localPricesByProduct);
  if (productIds.length === 0) return { ...PRECOS_LOCAIS_VAZIOS };
  const { data: productMappings, error } = await supabase
    .from('omie_products').select('id, omie_codigo_produto, account').in('id', productIds);
  // Falha do mapeamento → degrada honesto (cada conta cai p/ o preço de tabela
  // `valor_unitario`, nunca R$0), mas deixa RASTRO: sem ele o preço-cliente
  // sumiria silencioso mesmo com a RPC tendo retornado preços (Codex P2).
  // `estrito` (edição de pedido): a falha do mapeamento LANÇA, para o caller avisar o vendedor — com
  // mapas vazios o item nasceria pela tabela calado, embora a RPC tenha devolvido o praticado (Codex).
  if (error && opcoes.estrito) throw error;
  if (error) {
    logger.warn('resolveLocalPricesByOmieCode: mapeamento omie_products falhou (degrada p/ preço de tabela)', {
      stage: 'resolve_local_prices_omie_map',
      productIdsCount: productIds.length,
      error,
    });
  }
  return montarPrecosLocaisPorConta(localPricesByProduct, productMappings ?? [], datasByProduct);
}

/** Lê e resolve os preços praticados de UM cliente. Lança se a RPC OU o mapeamento falhar (o caller
 *  decide a degradação e o aviso). */
export async function carregarPrecosPraticados(customerUserId: string): Promise<PrecosLocaisPorConta> {
  const { data, error } = await supabase.rpc('get_ultimos_precos_cliente', { p_customer: customerUserId });
  if (error) throw error;
  return resolverPrecosLocaisPorConta((data as LinhaPrecoPraticado[] | null) ?? null, { estrito: true });
}
