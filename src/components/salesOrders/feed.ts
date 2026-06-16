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

// Normaliza pra busca: minúsculas + sem diacríticos ("afiacao" acha "Afiação").
const normalizar = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export function filterFeedRows(
  rows: OrderFeedRow[],
  search: string,
  accountFilter: Account,
): OrderFeedRow[] {
  // Afiação já vem da view com account='colacor_sc' (opera sob a entidade SC),
  // então o filtro de aba é uniforme — sem caso especial.
  let result = accountFilter === 'all' ? rows : rows.filter((r) => r.account === accountFilter);

  const q = normalizar(search.trim());
  if (q) {
    // Busca numérica em formato BR: "250,50" também casa o total 250.50.
    const qNum = q.replace(',', '.');
    result = result.filter((r) => {
      const name = normalizar(decodeHtml(r.customer_name || ''));
      const pv = (r.order_number || '').toLowerCase();
      const items = normalizar((r.item_names || []).join(' '));
      const total = Number(r.total ?? 0).toFixed(2);
      return name.includes(q) || pv.includes(q) || items.includes(q) || total.includes(q) || total.includes(qNum);
    });
  }
  return result;
}

// Dedupe por (origin, id) preservando a 1ª ocorrência. Defesa contra o caso raro
// de escrita concorrente durante o fetch paginado por offset (uma inserção entre
// as páginas pode deslocar e repetir uma linha — duplicata quebraria as keys do React).
export function dedupeFeedRows(rows: OrderFeedRow[]): OrderFeedRow[] {
  const seen = new Set<string>();
  const out: OrderFeedRow[] = [];
  for (const r of rows) {
    const key = `${r.origin}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// sales_orders.* → SalesOrder. A linha já tem o shape (items jsonb compatível);
// marca a origem e NORMALIZA items: jsonb malformado (objeto em vez de array)
// quebraria o painel/impressão — ({} || []).map não existe (achado do codex).
export function mapSalesDetail(row: SalesOrderRow): SalesOrder {
  const base = row as unknown as SalesOrder;
  return { ...base, items: Array.isArray(base.items) ? base.items : [], _source: 'sales' };
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
      // ?? (não ||): quantity 0 real fica 0 — mesma regra da view (ausente → 1).
      quantidade: i.quantity ?? 1,
      valor_unitario: i.unitPrice || 0,
      valor_total: (i.quantity ?? 1) * (i.unitPrice || 0),
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
