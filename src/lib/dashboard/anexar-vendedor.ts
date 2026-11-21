import { supabase } from '@/integrations/supabase/client';

/**
 * Lote da RPC `pedidos_vendedor` — abaixo do teto de 1000 dela (e do cap de linhas do PostgREST,
 * que vale também para `.rpc()`): cada chamada devolve no máximo um lote de linhas.
 */
export const LOTE_VENDEDOR = 500;

/**
 * Anexa o vendedor do Omie (`vendedor_user_id`) a pedidos JÁ lidos. A coluna é fechada para
 * `authenticated` (sales_orders é fechada por coluna desde 20260709163500): pedir no `.select()`
 * do PostgREST dá 403 na leitura INTEIRA. A leitura é pela RPC `pedidos_vendedor` (SECURITY
 * DEFINER, gate de staff — migration 20261121140000).
 *
 * Id que a RPC não devolve → `null` ("sem vendedor"), nunca chute. Lança em qualquer falha: quem
 * chama mostra "—", não um número de vendedores inventado.
 */
export async function anexarVendedor<T extends { id: string }>(
  pedidos: T[],
): Promise<Array<T & { vendedor_user_id: string | null }>> {
  const vendedorPorId = new Map<string, string | null>();
  const ids = [...new Set(pedidos.map((p) => p.id))];
  for (let i = 0; i < ids.length; i += LOTE_VENDEDOR) {
    const lote = ids.slice(i, i + LOTE_VENDEDOR);
    const { data, error } = await supabase.rpc('pedidos_vendedor', { p_ids: lote });
    if (error) throw new Error(`pedidos_vendedor: ${error.message}`);
    if (!Array.isArray(data)) throw new Error('pedidos_vendedor: data null sem error');
    for (const linha of data) vendedorPorId.set(linha.id, linha.vendedor_user_id ?? null);
  }
  return pedidos.map((p) => ({ ...p, vendedor_user_id: vendedorPorId.get(p.id) ?? null }));
}
