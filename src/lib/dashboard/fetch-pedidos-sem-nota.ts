import { supabase } from '@/integrations/supabase/client';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import type { CompanySelection } from '@/contexts/CompanyContext';
import type { Janela } from './crescimento-comparavel';
import { PAGINA_JANELA, paginarPorId } from './paginar-por-id';
import { STATUS_SEM_NOTA } from './pedidos-sem-nota';

export interface PedidoSemNotaRow {
  id: string;
  total: number | null;
  account: string;
}

/**
 * Pedidos de VENDA (universo canônico) que ainda estão sem nota no Omie (`STATUS_SEM_NOTA`), com
 * `order_date_kpi` em [de, ate). Estreitar por status é PROPÓSITO, registrado no gate do universo
 * (`src/lib/gates/universo-pedidos-ts-registro.ts`): a pergunta é "quanto da venda ainda não virou
 * nota?", não "quanto vendemos?". Paginada por cursor; lança em qualquer falha.
 */
export function fetchPedidosSemNota(selection: CompanySelection, janela: Janela): Promise<PedidoSemNotaRow[]> {
  return paginarPorId<PedidoSemNotaRow>('sales_orders (sem nota)', (cursor) => {
    let q = supabase
      .from('sales_orders')
      .select('id, total, account')
      .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
      .is('deleted_at', null)
      .in('status', [...STATUS_SEM_NOTA])
      .gte('order_date_kpi', janela.de)
      .lt('order_date_kpi', janela.ate);
    if (selection !== 'all') q = q.eq('account', selection);
    if (cursor != null) q = q.gt('id', cursor);
    return q.order('id', { ascending: true }).limit(PAGINA_JANELA) as unknown as PromiseLike<{
      data: PedidoSemNotaRow[] | null;
      error: { message: string } | null;
    }>;
  });
}
