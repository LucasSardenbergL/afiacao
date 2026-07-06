import type { SubmitClient } from './types';
import type { Json } from '@/integrations/supabase/types';

export type SalesOrderAction = 'insert' | 'reuse' | 'skip';

/**
 * Decide o que fazer com a linha de sales_orders de um (checkout_id, account).
 * O sinal de "já no Omie" é omie_pedido_id (NÃO o status — o sync de entrada muda
 * o status p/ faturado/separacao/importado após o envio; usar status reenviaria).
 *  - null                → 'insert'
 *  - omie_pedido_id != null → 'skip'  (idempotência: já está no Omie)
 *  - omie_pedido_id null    → 'reuse' (tentativa anterior não chegou no Omie)
 */
export function decideSalesOrderAction(
  existing: { omie_pedido_id: number | null } | null,
): SalesOrderAction {
  if (!existing) return 'insert';
  if (existing.omie_pedido_id != null) return 'skip';
  return 'reuse';
}

export interface EnsureSalesOrderArgs {
  checkoutId: string;
  account: string;
  origem: string | null;
  atendimentoId: string | null;
  fields: {
    customer_user_id: string; created_by: string; items: Json;
    subtotal: number; total: number; notes: string | null;
    customer_document: string | null;
    customer_address: string | null; customer_phone: string | null; ready_by_date: string | null;
  };
}

/**
 * Garante 1 linha de sales_orders por (checkout_id, account), idempotente:
 *  - já no Omie (omie_pedido_id) → não toca; alreadySent=true → o caller PULA o edge.
 *  - rascunho                    → atualiza os campos do carrinho atual; reusa o id.
 *  - inexistente                 → insere; em corrida (23505) re-busca e reusa.
 * O id é estável entre retries do mesmo checkout → a chave determinística PV_<id> também.
 */
export async function ensureSalesOrderRow(
  supabase: SubmitClient,
  args: EnsureSalesOrderArgs,
): Promise<{ id: string; alreadySent: boolean }> {
  const { checkoutId, account, origem, atendimentoId, fields } = args;

  const findExisting = async (): Promise<{ id: string; omie_pedido_id: number | null } | null> => {
    const { data, error } = await supabase
      .from('sales_orders').select('id, omie_pedido_id')
      .eq('checkout_id', checkoutId).eq('account', account).maybeSingle();
    if (error) throw error;
    return (data as { id: string; omie_pedido_id: number | null } | null) ?? null;
  };

  const existing = await findExisting();
  const action = decideSalesOrderAction(existing);

  if (action === 'skip') return { id: existing!.id, alreadySent: true };

  if (action === 'reuse') {
    const { error } = await supabase.from('sales_orders').update({
      items: fields.items, subtotal: fields.subtotal, total: fields.total, notes: fields.notes,
      customer_document: fields.customer_document,
      customer_address: fields.customer_address, customer_phone: fields.customer_phone,
      ready_by_date: fields.ready_by_date,
    }).eq('id', existing!.id);
    if (error) throw error;
    return { id: existing!.id, alreadySent: false };
  }

  const { data, error } = await supabase.from('sales_orders').insert({
    ...fields, status: 'rascunho', account, checkout_id: checkoutId, origem, atendimento_id: atendimentoId,
  }).select('id').single();

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      const raced = await findExisting();
      if (raced) return { id: raced.id, alreadySent: decideSalesOrderAction(raced) === 'skip' };
      // 23505 mas a linha conflitante sumiu antes da re-busca (deleção concorrente rara) —
      // erro contextual em vez do PostgresError 23505 opaco (anti-falha-silenciosa).
      throw new Error(
        `Corrida de inserção (23505) em sales_orders (checkout_id=${checkoutId}, account=${account}): a linha conflitante sumiu antes da re-busca — tente novamente.`,
      );
    }
    throw error;
  }
  return { id: data.id, alreadySent: false };
}
