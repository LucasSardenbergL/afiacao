import { supabase } from '@/integrations/supabase/client';
import { fetchAllPagesComMensagem } from '@/lib/postgrest';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import type { CompanySelection } from '@/contexts/CompanyContext';

export interface PedidoMTDRow {
  total: number | null;
  status: string | null;
  /** Cliente do pedido — o ranking credita a venda ao dono da carteira dele. */
  customer_user_id: string | null;
  order_date_kpi: string | null;
}


/**
 * Busca TODOS os pedidos com `order_date_kpi` em [deISO, ateISO), escopados na empresa
 * (selection single → `.eq('account')`; 'all' → grupo). **Paginado** pelo canônico
 * (`fetchAllPagesComMensagem`, `order('id')`) pra furar o cap de 1000 do PostgREST — a receita do
 * mês NÃO pode truncar (money). Lança em erro ou `data: null` sem error; página perdida é medida.
 */
export async function fetchPedidosMTD(
  selection: CompanySelection,
  deISO: string,
  ateISO: string,
): Promise<PedidoMTDRow[]> {
  return fetchAllPagesComMensagem<PedidoMTDRow>(
    (de, ate) => {
      let q = supabase
        .from('sales_orders')
        .select('total, status, customer_user_id, order_date_kpi')
        // O universo de VENDA na query (era só o deleted_at, e o status vinha do isPedidoValido em
        // memória com uma cópia de 2 status — orçamento e pendente contariam como receita).
        .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
        .is('deleted_at', null)
        .gte('order_date_kpi', deISO)
        .lt('order_date_kpi', ateISO);
      if (selection !== 'all') q = q.eq('account', selection);
      return q.order('id', { ascending: true }).range(de, ate);
    },
    'sales_orders/dashboard-mtd',
    'sales_orders (MTD)',
  );
}
