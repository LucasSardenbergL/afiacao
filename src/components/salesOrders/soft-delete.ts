import { supabase } from '@/integrations/supabase/client';
import { mensagemDoErroEdge } from '@/lib/invoke-function';

export type SoftDeleteResult =
  | { ok: true }
  | { ok: false; stage: 'supabase' | 'omie'; message: string };

/**
 * Soft-delete de UM pedido (caminho do dinheiro):
 *  1. UPDATE sales_orders SET deleted_at=now() (audit trail antes do Omie).
 *  2. Omie excluir_pedido.
 *  3. Se o Omie falha, rollback (deleted_at=null) — pedido volta a ativo.
 * Não mexe em cache/UI (responsabilidade do caller).
 */
export async function softDeleteOrder(order: { id: string; omie_pedido_id: number | null }): Promise<SoftDeleteResult> {
  const { error: softErr } = await supabase
    .from('sales_orders')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', order.id);
  if (softErr) return { ok: false, stage: 'supabase', message: softErr.message };

  const { error: omieErr } = await supabase.functions.invoke('omie-vendas-sync', {
    body: { action: 'excluir_pedido', sales_order_id: order.id, omie_pedido_id: order.omie_pedido_id },
  });
  if (omieErr) {
    const message = (await mensagemDoErroEdge(omieErr)) ?? omieErr.message ?? String(omieErr);
    const { error: rollbackErr } = await supabase.from('sales_orders').update({ deleted_at: null }).eq('id', order.id);
    if (rollbackErr) {
      // o pedido continua no ERP mas ficou ESCONDIDO no app — dizer, nunca engolir
      return { ok: false, stage: 'omie', message: `${message} — e o pedido ficou oculto no app (falha ao desfazer: ${rollbackErr.message}). Avise o suporte.` };
    }
    return { ok: false, stage: 'omie', message };
  }
  return { ok: true };
}
