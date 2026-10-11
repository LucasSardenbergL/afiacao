import { supabase } from '@/integrations/supabase/client';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import type { CompanySelection } from '@/contexts/CompanyContext';
import type { Janela } from './crescimento-comparavel';

export interface PedidoJanelaRow {
  id: string;
  total: number | null;
  customer_user_id: string | null;
  /** A chave do cliente é (empresa, cliente): no grupo, o mesmo cliente tem um cadastro por CNPJ. */
  account: string;
}

export const PAGINA_JANELA = 1000;

/**
 * Todos os pedidos do universo de venda com `order_date_kpi` em [de, ate), escopados na empresa
 * ('all' → grupo). Pagina por CURSOR de `id` (não offset: um pedido cancelado entre duas páginas
 * deslocaria o offset e pularia outro). Não é snapshot transacional — valores podem mudar durante
 * a leitura, aceitável para um painel de gestão. Lança em qualquer falha: nunca devolve parcial.
 */
export async function fetchPedidosJanela(
  selection: CompanySelection,
  janela: Janela,
): Promise<PedidoJanelaRow[]> {
  const out: PedidoJanelaRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    let q = supabase
      .from('sales_orders')
      .select('id, total, customer_user_id, account')
      .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
      .is('deleted_at', null)
      .gte('order_date_kpi', janela.de)
      .lt('order_date_kpi', janela.ate);
    if (selection !== 'all') q = q.eq('account', selection);
    if (cursor != null) q = q.gt('id', cursor);
    const { data, error } = await q.order('id', { ascending: true }).limit(PAGINA_JANELA);
    if (error) throw new Error(error.message);
    if (data == null) throw new Error('sales_orders (janela): data null sem error — malformada, não é fim');
    const rows = data as PedidoJanelaRow[];
    out.push(...rows);
    if (rows.length < PAGINA_JANELA) return out;
    const ultimo = rows[rows.length - 1].id;
    if (ultimo === cursor) throw new Error('sales_orders (janela): cursor não avançou — leitura abortada');
    cursor = ultimo;
  }
}
