import { supabase } from '@/integrations/supabase/client';
import type { CompanySelection } from '@/contexts/CompanyContext';

export interface PedidoMTDRow {
  total: number | null;
  status: string | null;
  created_by: string | null;
  order_date_kpi: string | null;
}

const PAGE = 1000;

/**
 * Busca TODOS os pedidos com `order_date_kpi` em [deISO, ateISO), escopados na empresa
 * (selection single → `.eq('account')`; 'all' → grupo). **Paginado** (`.range` + `order('id')`)
 * pra furar o cap de 1000 do PostgREST — a receita do mês NÃO pode truncar (money). Lança em erro.
 */
export async function fetchPedidosMTD(
  selection: CompanySelection,
  deISO: string,
  ateISO: string,
): Promise<PedidoMTDRow[]> {
  const out: PedidoMTDRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from('sales_orders')
      .select('total, status, created_by, order_date_kpi')
      .is('deleted_at', null)
      .gte('order_date_kpi', deISO)
      .lt('order_date_kpi', ateISO)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (selection !== 'all') q = q.eq('account', selection);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as PedidoMTDRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}
