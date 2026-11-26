// Detalhe completo de um pedido por (origin, id). A listagem (view order_feed) é
// enxuta de propósito — itens completos, payload de parcelas e endereço só são
// buscados quando o usuário abre o painel, imprime ou compartilha.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { omiePayloadDoJson } from '@/lib/pedido/itens-json';
import { lerContatoOperacional, lerPerfilContato } from '@/lib/contato-cliente';
import { decodeHtml, type OrderDetail, type OrderFeedRow } from './types';
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
// ehStaff: o contato do cliente (snapshot de endereço/telefone/documento) vem pelo contexto
// OPERACIONAL (`contato_cliente_operacional`, objeto = o pedido, gravado no ledger fora da carteira)
// para staff; o customer lê o PRÓPRIO pedido e o próprio perfil (onda D).
export async function fetchOrderDetail(
  origin: OrderFeedRow['origin'],
  id: string,
  fallbackName: string | null | undefined,
  ehStaff: boolean,
): Promise<OrderDetail> {
  let order;
  if (origin === 'sales') {
    // Colunas explícitas (PR0.0-bis): omie_payload/omie_response fechados à leitura de
    // `authenticated` — um `.select('*')` daria 42501 (o * inteiro cai).
    const { data, error } = await supabase
      .from('sales_orders')
      .select('id, customer_user_id, items, subtotal, discount, total, status, notes, account, omie_pedido_id, omie_numero_pedido, created_at')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Pedido não encontrado');
    const snap = await snapshotDoPedido(id, ehStaff);
    order = mapSalesDetail({ ...data, customer_address: snap.endereco, customer_phone: snap.telefone });
    // A impressão do cupom lê cabecalho.codigo_parcela do payload — recupera pelo canal staff
    // SECDEF. Degrada honestamente (impressão sem parcela detalhada) se indisponível; não
    // bloqueia o painel de detalhe por causa da impressão. supabase.rpc RETORNA o erro (não
    // lança) → checa explicitamente e SINALIZA (não silencioso — money-path: ausente ≠ silêncio).
    const { data: pl, error: plErr } = await supabase.rpc('staff_get_sales_order_payload', { p_order_ids: [id] });
    if (plErr) {
      console.warn('[useSalesOrderDetail] payload staff indisponível (impressão sem parcela):', plErr);
    } else {
      const payload = omiePayloadDoJson(pl?.[0]?.omie_payload ?? null, `sales_orders ${id}`);
      if (payload) order.omie_payload = payload;
    }
  } else {
    const { data, error } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Pedido não encontrado');
    order = mapAfiacaoDetail(data);
  }

  const { data: prof, error: profError } = await supabase
    .from('profiles')
    .select('name')
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
    customerDocument: await documentoDoCliente(origin, id, order.customer_user_id, ehStaff),
  };
}

/** Snapshot de entrega gravado no pedido. Staff: RPC operacional; customer: o próprio pedido. */
async function snapshotDoPedido(id: string, ehStaff: boolean): Promise<{ endereco: string | null; telefone: string | null }> {
  if (ehStaff) {
    const c = (await lerContatoOperacional('pedido', [id], 'detalhe_pedido')).get(id);
    return { endereco: c?.pedido_endereco ?? null, telefone: c?.pedido_telefone ?? null };
  }
  // Onda D fatia 4a: o cliente lê o snapshot do PRÓPRIO pedido pela view-gate (as colunas cruas de
  // sales_orders fecham a authenticated em 20261126170000).
  const { data, error } = await supabase
    .from('v_pedido_snapshot_proprio').select('customer_address, customer_phone').eq('id', id).maybeSingle();
  if (error) throw error;
  return { endereco: data?.customer_address ?? null, telefone: data?.customer_phone ?? null };
}

/** Documento do cliente do pedido; falha de leitura → undefined (impressão sem documento, honesto). */
async function documentoDoCliente(
  origin: OrderFeedRow['origin'], id: string, customerUserId: string, ehStaff: boolean,
): Promise<string | undefined> {
  try {
    if (ehStaff) {
      const c = (await lerContatoOperacional(origin === 'sales' ? 'pedido' : 'ordem_servico', [id],
        origin === 'sales' ? 'detalhe_pedido' : 'detalhe_os')).get(id);
      return c?.document ?? undefined;
    }
    return (await lerPerfilContato(customerUserId))?.document ?? undefined;
  } catch (e) {
    console.warn('[useSalesOrderDetail] documento do cliente indisponível:', e);
    return undefined;
  }
}

// Sem placeholderData entre ids: trocar de pedido NUNCA mostra dados do anterior.
export function useSalesOrderDetail(
  row: (Pick<OrderFeedRow, 'origin' | 'id'> & { customer_name?: string | null }) | null,
) {
  const { user, isStaff } = useAuth();
  return useQuery({
    queryKey: orderDetailQueryKey(user?.id, row?.origin ?? 'sales', row?.id ?? ''),
    enabled: !!row && !!user,
    staleTime: 60_000,
    queryFn: () => fetchOrderDetail(row!.origin, row!.id, row!.customer_name, isStaff),
  });
}
