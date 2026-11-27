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

/** O pedido não existe (ou foi excluído) — não é falha de leitura: não se repete nem se oferece "tentar de novo". */
export class PedidoNaoEncontrado extends Error {
  constructor(id: string) {
    super(`Pedido não encontrado (${id})`);
    this.name = 'PedidoNaoEncontrado';
  }
}

// Key compartilhada entre o painel (useQuery) e as ações imperativas
// (imprimir/compartilhar via queryClient.fetchQuery) — mesmo cache, sem fetch dobrado.
export const orderDetailQueryKey = (
  userId: string | undefined,
  origin: OrderFeedRow['origin'],
  id: string,
) => ['order-detail', userId, origin, id] as const;

// fallbackName: nome vindo da listagem (view) — usado se a consulta de profile
// falhar transitoriamente, pra impressão/share não saírem como "Cliente" genérico.
// ehStaff: decide o canal do contato (`contatoDoPedido`).
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
    if (!data) throw new PedidoNaoEncontrado(id);
    order = mapSalesDetail({ ...data, customer_address: null, customer_phone: null });
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
    if (!data) throw new PedidoNaoEncontrado(id);
    order = mapAfiacaoDetail(data);
  }

  // Contato (endereço/telefone/documento) é do CUPOM, não do painel: a falha dele não derruba itens e
  // notas (revisão /sales #22 — na lente a RPC operacional, que grava o ledger, é bloqueada). UMA
  // leitura só: antes o pedido comercial chamava a mesma RPC duas vezes (snapshot e documento).
  const contato = await contatoDoPedido(origin, id, order.customer_user_id, ehStaff);
  if (contato) {
    order.customer_address = contato.endereco;
    order.customer_phone = contato.telefone;
  }

  const { data: prof, error: profError } = await supabase
    .from('profiles')
    .select('name')
    .eq('user_id', order.customer_user_id)
    .maybeSingle();
  const base = {
    order,
    customerDocument: contato?.documento ?? undefined,
    ...(contato ? {} : { contatoIndisponivel: true as const }),
  };
  // Falha transitória do profile não degrada pra "Cliente" se a listagem já
  // sabe o nome (mesma fonte, via view).
  if (profError && !prof) return { ...base, customerName: decodeHtml(fallbackName || 'Cliente') };
  return { ...base, customerName: decodeHtml(prof?.name || fallbackName || 'Cliente') };
}

interface ContatoDoPedido { endereco: string | null; telefone: string | null; documento: string | null }

/**
 * Contato gravado no pedido + documento do cliente, ou `null` quando a leitura FALHOU (≠ "sem
 * contato": o cupom sai sem esses campos e a equipe é avisada). Staff: a RPC operacional (objeto = o
 * pedido/OS, gravada no ledger); customer: o próprio pedido pela view-gate e o próprio perfil (onda D).
 */
async function contatoDoPedido(
  origin: OrderFeedRow['origin'], id: string, customerUserId: string, ehStaff: boolean,
): Promise<ContatoDoPedido | null> {
  try {
    if (ehStaff) {
      const c = (await lerContatoOperacional(origin === 'sales' ? 'pedido' : 'ordem_servico', [id],
        origin === 'sales' ? 'detalhe_pedido' : 'detalhe_os')).get(id);
      return {
        endereco: origin === 'sales' ? c?.pedido_endereco ?? null : null,
        telefone: origin === 'sales' ? c?.pedido_telefone ?? null : null,
        documento: c?.document ?? null,
      };
    }
    // Onda D fatia 4a: o cliente lê o snapshot do PRÓPRIO pedido pela view-gate (as colunas cruas de
    // sales_orders fecham a authenticated em 20261126170000).
    let endereco: string | null = null;
    let telefone: string | null = null;
    if (origin === 'sales') {
      const { data, error } = await supabase
        .from('v_pedido_snapshot_proprio').select('customer_address, customer_phone').eq('id', id).maybeSingle();
      if (error) throw error;
      endereco = data?.customer_address ?? null;
      telefone = data?.customer_phone ?? null;
    }
    return { endereco, telefone, documento: (await lerPerfilContato(customerUserId))?.document ?? null };
  } catch (e) {
    console.warn('[useSalesOrderDetail] contato do cliente indisponível (cupom sem endereço/documento):', e);
    return null;
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
    retry: (falhas, erro) => !(erro instanceof PedidoNaoEncontrado) && falhas < 2,
    queryFn: () => fetchOrderDetail(row!.origin, row!.id, row!.customer_name, isStaff),
  });
}
