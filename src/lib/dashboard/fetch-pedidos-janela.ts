import { supabase } from '@/integrations/supabase/client';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import type { CompanySelection } from '@/contexts/CompanyContext';
import type { Janela } from './crescimento-comparavel';
import { PAGINA_JANELA, paginarPorId } from './paginar-por-id';

export { PAGINA_JANELA };

export interface PedidoJanelaRow {
  id: string;
  total: number | null;
  customer_user_id: string | null;
  /** A chave do cliente é (empresa, cliente): no grupo, o mesmo cliente tem um cadastro por CNPJ. */
  account: string;
}

/**
 * Todos os pedidos do universo de venda com `order_date_kpi` em [de, ate), escopados na empresa
 * ('all' → grupo). Pagina por CURSOR de `id` (`./paginar-por-id`). Não é snapshot transacional — valores
 * podem mudar durante a leitura, aceitável para um painel de gestão. Lança em qualquer falha: nunca
 * devolve parcial. Cadeia CANÔNICA de propósito: estreitar por status é outra pergunta e tem leitura
 * própria (`./fetch-pedidos-sem-nota`) — o gate do universo julga a forma desta cadeia.
 */
export function fetchPedidosJanela(selection: CompanySelection, janela: Janela): Promise<PedidoJanelaRow[]> {
  return paginarPorId<PedidoJanelaRow>('sales_orders (janela)', (cursor) => {
    let q = supabase
      .from('sales_orders')
      .select('id, total, customer_user_id, account')
      .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
      .is('deleted_at', null)
      .gte('order_date_kpi', janela.de)
      .lt('order_date_kpi', janela.ate);
    if (selection !== 'all') q = q.eq('account', selection);
    if (cursor != null) q = q.gt('id', cursor);
    return q.order('id', { ascending: true }).limit(PAGINA_JANELA) as unknown as PromiseLike<{
      data: PedidoJanelaRow[] | null;
      error: { message: string } | null;
    }>;
  });
}
