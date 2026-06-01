import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import type { OutcomeStatus } from '@/lib/route/route-outcome';

// route_* não está no types.ts gerado → cast do client (mesmo padrão de useMyPositivacao).
type RpcClient = { rpc(fn: string, params?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };
const rpc = () => supabase as unknown as RpcClient;

export interface RegistrarContatoVars {
  customerUserId: string;
  status: OutcomeStatus;
  dataRota: string;            // 'yyyy-mm-dd' (a data_rota da fila)
  bucket?: string | null;
  valor?: number | null;
}

/** Registra o resultado de uma ligação via RPC (farmer server-side, dedupe). Retorna {id, deduped}. */
export function useRegistrarContato() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: RegistrarContatoVars): Promise<{ id: string; deduped: boolean }> => {
      const { data, error } = await rpc().rpc('registrar_contato_rota', {
        p_customer_user_id: v.customerUserId,
        p_status: v.status,
        p_data_rota: v.dataRota,
        p_bucket: v.bucket ?? null,
        p_valor: v.valor ?? null,
      });
      if (error) throw new Error(error.message);
      track('rota.contato_registrado', { status: v.status });
      return (data ?? { id: '', deduped: false }) as { id: string; deduped: boolean };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['route-contact-list'] }),
  });
}

/** Desfaz (deleta) o último registro próprio recente (own + <5min). Retorna {deleted}. */
export function useDesfazerContato() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<{ deleted: boolean }> => {
      const { data, error } = await rpc().rpc('desfazer_contato_rota', { p_id: id });
      if (error) throw new Error(error.message);
      track('rota.contato_desfeito', {});
      return (data ?? { deleted: false }) as { deleted: boolean };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['route-contact-list'] }),
  });
}
