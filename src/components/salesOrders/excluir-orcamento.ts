import { supabase } from '@/integrations/supabase/client';
import { mensagemDoErroEdge } from '@/lib/invoke-function';

/**
 * Exclui um orçamento/rascunho.
 *
 * 1. DELETE direto (policy `sales_orders_delete_staff`): só apaga o que nunca foi enviado ao Omie —
 *    sem PID, em orçamento/rascunho e SEM reivindicação de envio (migration 20261120230001). RLS que
 *    barra não dá erro, devolve 0 linhas — por isso o `.select('id')`.
 * 2. 0 linhas ⇒ a edge `excluir_pedido`: o orçamento passou por um envio (pode ter PV vivo no Omie
 *    com o write-back perdido); a edge consulta `PV_<id>` e só apaga com ausência AFIRMADA, ou
 *    recusa dizendo por quê. Nunca "Orçamento excluído" sem ter apagado.
 */
export async function excluirOrcamento(id: string): Promise<void> {
  const { data, error } = await supabase.from('sales_orders').delete().eq('id', id).select('id');
  if (error) throw error;
  if (data && data.length > 0) return;

  const { error: edgeErr } = await supabase.functions.invoke('omie-vendas-sync', {
    body: { action: 'excluir_pedido', sales_order_id: id, omie_pedido_id: null },
  });
  if (edgeErr) {
    const motivo = (await mensagemDoErroEdge(edgeErr)) ?? edgeErr.message ?? String(edgeErr);
    throw new Error(motivo);
  }
}
