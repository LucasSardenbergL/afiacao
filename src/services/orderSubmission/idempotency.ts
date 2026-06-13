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
