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

// fallbackName: nome vindo da listagem (view) — usado se a consulta de profile
// falhar transitoriamente, pra impressão/share não saírem como "Cliente" genérico.
export async function fetchOrderDetail(
  origin: OrderFeedRow['origin'],
  id: string,
  fallbackName?: string | null,
): Promise<OrderDetail> {
  let order;
  if (origin === 'sales') {
    // Colunas explícitas (PR0.0-bis): omie_payload/omie_response fechados à leitura de
    // `authenticated` — um `.select('*')` daria 42501 (o * inteiro cai).
    const { data, error } = await supabase
      .from('sales_orders')
      .select('id, customer_user_id, items, subtotal, discount, total, status, notes, account, omie_pedido_id, omie_numero_pedido, created_at, customer_address, customer_phone, customer_document')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Pedido não encontrado');
    order = mapSalesDetail(data as unknown as SalesOrderRow);
    // A impressão do cupom lê cabecalho.codigo_parcela do payload — recupera pelo canal staff
    // SECDEF. Degrada honestamente (impressão sem parcela detalhada) se indisponível; não
    // bloqueia o painel de detalhe por causa da impressão. supabase.rpc RETORNA o erro (não
    // lança) → checa explicitamente e SINALIZA (não silencioso — money-path: ausente ≠ silêncio).
    const { data: pl, error: plErr } = await supabase.rpc(
      'staff_get_sales_order_payload' as never,
      { p_order_ids: [id] } as never,
    );
    if (plErr) {
      console.warn('[useSalesOrderDetail] payload staff indisponível (impressão sem parcela):', plErr);
    } else {
      const payload = (pl as unknown as Array<{ omie_payload: unknown }> | null)?.[0]?.omie_payload;
      if (payload) order.omie_payload = payload;
    }
  } else {
    const { data, error } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Pedido não encontrado');
    order = mapAfiacaoDetail(data as AfiacaoOrderRow);
  }

  const { data: prof, error: profError } = await supabase
    .from('profiles')
    .select('name, document')
    .eq('user_id', order.customer_user_id)
    .maybeSingle();
  // Falha transitória do profile não degrada pra "Cliente" se a listagem já
  // sabe o nome (mesma fonte, via view). Documento fica de fora (honesto).
  if (profError && !prof) {
    return { order, customerName: decodeHtml(fallbackName || 'Cliente'), customerDocument: undefined };
  }

  return {
    order,
    customerName: decodeHtml(prof?.name || fallbackName || 'Cliente'),
    customerDocument: prof?.document ?? undefined,
  };
}

// Sem placeholderData entre ids: trocar de pedido NUNCA mostra dados do anterior.
export function useSalesOrderDetail(
  row: (Pick<OrderFeedRow, 'origin' | 'id'> & { customer_name?: string | null }) | null,
) {
  const { user } = useAuth();
  return useQuery({
    queryKey: orderDetailQueryKey(user?.id, row?.origin ?? 'sales', row?.id ?? ''),
    enabled: !!row && !!user,
    staleTime: 60_000,
    queryFn: () => fetchOrderDetail(row!.origin, row!.id, row!.customer_name),
  });
}
