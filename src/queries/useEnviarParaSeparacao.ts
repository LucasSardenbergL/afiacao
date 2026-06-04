import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';

// ensure_picking_task_for_sales_order não está no types gerado → cast do client.
type RpcClient = { rpc(fn: string, p?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };

/** Envia um pedido para separação (cria a picking_task idempotente via RPC). Retorna {task_id, created}. */
export function useEnviarParaSeparacao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (salesOrderId: string): Promise<{ task_id: string; created: boolean }> => {
      const { data, error } = await (supabase as unknown as RpcClient).rpc('ensure_picking_task_for_sales_order', {
        p_sales_order_id: salesOrderId,
      });
      if (error) throw new Error(error.message);
      return data as { task_id: string; created: boolean };
    },
    onSuccess: () => {
      track('picking.enviado_separacao', {});
      for (const k of [
        ['pk-pedidos-a-separar'],
        ['pk-picking-list'],
        ['pk-tasks-abertas'],
        ['pk-pedidos-aguardando'],
        ['touch-pk-tasks'],
      ]) {
        qc.invalidateQueries({ queryKey: k });
      }
    },
  });
}
