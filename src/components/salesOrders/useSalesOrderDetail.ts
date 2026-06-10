// Detalhe completo de um pedido por (origin, id). A listagem (view order_feed) é
// enxuta de propósito — itens completos, payload de parcelas e endereço só são
// buscados quando o usuário abre o painel, imprime ou compartilha.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import {
  decodeHtml,
  type AfiacaoOrderRow,
  type OrderDetail,
  type OrderFeedRow,
  type SalesOrderRow,
} from './types';
import { mapAfiacaoDetail, mapSalesDetail } from './feed';

// Key compartilhada entre o painel (useQuery) e as ações imperativas
// (imprimir/compartilhar via queryClient.fetchQuery) — mesmo cache, sem fetch dobrado.
export const orderDetailQueryKey = (
  userId: string | undefined,
  origin: OrderFeedRow['origin'],
  id: string,
) => ['order-detail', userId, origin, id] as const;

export async function fetchOrderDetail(
  origin: OrderFeedRow['origin'],
  id: string,
): Promise<OrderDetail> {
  let order;
  if (origin === 'sales') {
    const { data, error } = await supabase.from('sales_orders').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Pedido não encontrado');
    order = mapSalesDetail(data as SalesOrderRow);
  } else {
    const { data, error } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Pedido não encontrado');
    order = mapAfiacaoDetail(data as AfiacaoOrderRow);
  }

  const { data: prof } = await supabase
    .from('profiles')
    .select('name, document')
    .eq('user_id', order.customer_user_id)
    .maybeSingle();

  return {
    order,
    customerName: decodeHtml(prof?.name || 'Cliente'),
    customerDocument: prof?.document ?? undefined,
  };
}

// Sem placeholderData entre ids: trocar de pedido NUNCA mostra dados do anterior.
export function useSalesOrderDetail(row: Pick<OrderFeedRow, 'origin' | 'id'> | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: orderDetailQueryKey(user?.id, row?.origin ?? 'sales', row?.id ?? ''),
    enabled: !!row && !!user,
    staleTime: 60_000,
    queryFn: () => fetchOrderDetail(row!.origin, row!.id),
  });
}
