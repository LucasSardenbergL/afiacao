// Helpers puros da listagem unificada de pedidos (view order_feed).
// filterFeedRows: busca + filtro de empresa CLIENT-SIDE sobre o conjunto COMPLETO
// (a view carrega tudo numa query — fim do "Nenhum pedido" falso de quando a busca
// só enxergava as páginas baixadas).
// mapSalesDetail/mapAfiacaoDetail: normalizam a linha crua do detalhe (select('*')
// de sales_orders | orders) pro shape SalesOrder que painel/impressão/share consomem.
import {
  decodeHtml,
  type Account,
  type AfiacaoItemRaw,
  type AfiacaoOrderRow,
  type OrderFeedRow,
  type SalesOrder,
  type SalesOrderRow,
} from './types';

export function filterFeedRows(
  rows: OrderFeedRow[],
  search: string,
  accountFilter: Account,
): OrderFeedRow[] {
  // Afiação já vem da view com account='colacor_sc' (opera sob a entidade SC),
  // então o filtro de aba é uniforme — sem caso especial.
  let result = accountFilter === 'all' ? rows : rows.filter((r) => r.account === accountFilter);

  const q = search.trim().toLowerCase();
  if (q) {
    result = result.filter((r) => {
      const name = decodeHtml(r.customer_name || '').toLowerCase();
      const pv = (r.order_number || '').toLowerCase();
      const items = (r.item_names || []).join(' ').toLowerCase();
      const total = Number(r.total ?? 0).toFixed(2);
      return name.includes(q) || pv.includes(q) || items.includes(q) || total.includes(q);
    });
  }
  return result;
}

// sales_orders.* → SalesOrder. A linha já tem o shape (items jsonb compatível);
// só marca a origem. Cast consciente: items é Json no tipo gerado.
export function mapSalesDetail(row: SalesOrderRow): SalesOrder {
  return { ...(row as unknown as SalesOrder), _source: 'sales' };
}

// orders (afiação).* → SalesOrder. Mesma normalização que a listagem antiga fazia
// inline (category||name → descricao; quantity default 1; account = entidade SC).
export function mapAfiacaoDetail(row: AfiacaoOrderRow): SalesOrder {
  const rawItems = Array.isArray(row.items) ? (row.items as unknown as AfiacaoItemRaw[]) : [];
  return {
    id: row.id,
    customer_user_id: row.user_id,
    items: rawItems.map((i) => ({
      descricao: i.category || i.name || 'Afiação',
      quantidade: i.quantity || 1,
      valor_unitario: i.unitPrice || 0,
      valor_total: (i.quantity || 1) * (i.unitPrice || 0),
    })),
    subtotal: row.subtotal || row.total || 0,
    total: row.total || 0,
    status: row.status,
    omie_numero_pedido: null,
    omie_pedido_id: null,
    created_at: row.created_at,
    notes: row.notes,
    account: 'colacor_sc',
    _source: 'afiacao',
  };
}
