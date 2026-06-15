/**
 * cCodIntPed determinístico do pedido de venda. PV_<uuid> (39 chars < 60, limite Omie).
 * Determinístico (sem Date.now, sem truncar) → re-enviar o mesmo sales_order_id gera a
 * mesma chave → o Omie rejeita a duplicata → idempotência.
 * ⚠️ ESPELHADO verbatim em supabase/functions/omie-vendas-sync/index.ts.
 */
export function buildPedidoIntegrationCode(salesOrderId: string): string {
  return `PV_${salesOrderId}`;
}
