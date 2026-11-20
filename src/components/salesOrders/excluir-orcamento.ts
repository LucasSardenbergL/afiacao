import { supabase } from '@/integrations/supabase/client';

/**
 * Exclui um orçamento/rascunho pelo DELETE direto (policy `sales_orders_delete_staff`).
 *
 * A policy só apaga se o pedido não tem PID, está em orçamento/rascunho e NENHUM envio ao Omie o
 * reivindicou nos últimos 10 min (migration 20261120210002 — corrida conversão × exclusão). RLS que
 * barra o DELETE não dá erro: devolve 0 linhas. Por isso o `.select('id')` — 0 linhas é RECUSA
 * honesta, nunca "Orçamento excluído".
 */
export async function excluirOrcamento(id: string): Promise<void> {
  const { data, error } = await supabase.from('sales_orders').delete().eq('id', id).select('id');
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error(
      'o orçamento não pôde ser excluído — ele pode estar sendo enviado ao Omie agora, já ter virado pedido ou já ter sido excluído. Recarregue a página.',
    );
  }
}
