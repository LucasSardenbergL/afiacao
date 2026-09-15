// Leitura de `order_items` para o cupom impresso: o desconto de cada linha (`desconto_valor`) e a
// identidade que casa a linha com o item do jsonb (produto, quantidade, preço).
//
// Em LOTE porque o /sales/print imprime o dia inteiro de uma vez. Dois limites do PostgREST, cada um
// com o seu remédio: a capa SILENCIOSA de 1.000 linhas por request (`fetchAllPages` + ordem estável)
// e o tamanho da URL — o `.in()` vai na query string, e ~37 bytes por uuid estouram com centenas de
// pedidos (lotes de 100).
//
// Falha de página REJEITA (contrato do `fetchAllPages`): quem chama escolhe o fallback, e o cupom
// trata "não consegui ler" como aviso à equipe, nunca como "não há desconto".
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';
import type { LinhaDescontoItem } from './descontoCupom';

const IDS_POR_LOTE = 100;

type LinhaLida = LinhaDescontoItem & { id: string; sales_order_id: string };

/** order_items dos pedidos, agrupados por pedido. Todo pedido pedido volta no resultado — sem linhas, com `[]`. */
export async function buscarDescontosItens(
  pedidoIds: ReadonlyArray<string>,
): Promise<Record<string, LinhaDescontoItem[]>> {
  const porPedido: Record<string, LinhaDescontoItem[]> = {};
  for (const id of pedidoIds) porPedido[id] = [];
  for (let i = 0; i < pedidoIds.length; i += IDS_POR_LOTE) {
    const lote = pedidoIds.slice(i, i + IDS_POR_LOTE);
    const linhas = await fetchAllPages<LinhaLida>(
      (de, ate) =>
        supabase
          .from('order_items')
          .select('id, sales_order_id, omie_codigo_produto, quantity, unit_price, desconto_valor')
          .in('sales_order_id', lote)
          .order('sales_order_id', { ascending: true })
          .order('id', { ascending: true })
          .range(de, ate) as unknown as PromiseLike<{ data: LinhaLida[] | null; error: unknown }>,
      'order_items/desconto-cupom',
    );
    for (const { sales_order_id, omie_codigo_produto, quantity, unit_price, desconto_valor } of linhas) {
      porPedido[sales_order_id].push({ omie_codigo_produto, quantity, unit_price, desconto_valor });
    }
  }
  return porPedido;
}
