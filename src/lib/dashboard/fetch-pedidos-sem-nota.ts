import { supabase } from '@/integrations/supabase/client';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import type { CompanySelection } from '@/contexts/CompanyContext';
import type { Janela } from './crescimento-comparavel';
import { PAGINA_JANELA, paginarPorId } from './paginar-por-id';
import { STATUS_SEM_NOTA } from './pedidos-sem-nota';
import { anexarVendedor } from './anexar-vendedor';

import type { PedidoSemNotaDetalhe } from './pedidos-sem-nota';

/** Linha do pedido sem nota: o resumo usa `account`/`total`; a quebra por idade/cliente, o resto. */
export type PedidoSemNotaRow = PedidoSemNotaDetalhe;

/**
 * Pedidos de VENDA (universo canônico) que ainda estão sem nota no Omie (`STATUS_SEM_NOTA`), com
 * `order_date_kpi` em [de, ate). Estreitar por status é PROPÓSITO, registrado no gate do universo
 * (`src/lib/gates/universo-pedidos-ts-registro.ts`): a pergunta é "quanto da venda ainda não virou
 * nota?", não "quanto vendemos?". Paginada por cursor; lança em qualquer falha.
 */
export async function fetchPedidosSemNota(selection: CompanySelection, janela: Janela): Promise<PedidoSemNotaRow[]> {
  const pedidos = await paginarPorId<Omit<PedidoSemNotaRow, 'vendedor_user_id'>>('sales_orders (sem nota)', (cursor) => {
    let q = supabase
      .from('sales_orders')
      // SEM vendedor_user_id: coluna fechada para authenticated (403) — vem da RPC pedidos_vendedor.
      .select('id, total, account, order_date_kpi, customer_user_id, omie_numero_pedido')
      .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
      .is('deleted_at', null)
      .in('status', [...STATUS_SEM_NOTA])
      .gte('order_date_kpi', janela.de)
      .lt('order_date_kpi', janela.ate);
    if (selection !== 'all') q = q.eq('account', selection);
    if (cursor != null) q = q.gt('id', cursor);
    return q.order('id', { ascending: true }).limit(PAGINA_JANELA);
  });
  return anexarVendedor(pedidos);
}
