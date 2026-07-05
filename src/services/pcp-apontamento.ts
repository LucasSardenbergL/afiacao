import { supabase } from '@/integrations/supabase/client';

// RPCs do PCP F1B-M1 não estão nos types gerados (tabela/funções aplicadas via SQL Editor) →
// cast do client, mesmo padrão de picking-confirm.ts / useRegistrarContato.
type RpcClient = {
  rpc(fn: string, p?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
};

/**
 * Apontamento de execução (F1B-M1). Cada função chama uma RPC SECURITY DEFINER staff-gated,
 * idempotente por `eventId` (= client_event_id, PK do evento; replay offline→online não duplica).
 * A RPC retorna o estado projetado da OP (string). `criado_por` é derivado server-side (auth.uid()).
 */
export interface ApontarVars {
  /** crypto.randomUUID() gerado no toque — chave de idempotência do evento. */
  eventId: string;
  opId: string;
  deviceId: string;
  deviceSeq: number;
  /** ISO timestamp do momento do toque no device. */
  clientTs: string;
}

export interface ConsumoVars extends ApontarVars {
  componenteCodigo: number;
  quantidade: number;
  unidade: string;
  motivo: 'producao' | 'erro_formula' | 'teste' | 'ajuste';
  nota?: string | null;
}

export interface RefugoVars extends ApontarVars {
  quantidade: number;
  nota?: string | null;
}

async function callRpc(fn: string, params: Record<string, unknown>): Promise<string> {
  const { data, error } = await (supabase as unknown as RpcClient).rpc(fn, params);
  if (error) throw error;
  return (data as string) ?? '';
}

export function iniciarOP(v: ApontarVars): Promise<string> {
  return callRpc('fn_pcp_iniciar_apontamento', {
    p_event_id: v.eventId, p_op_id: v.opId, p_device_id: v.deviceId,
    p_device_seq: v.deviceSeq, p_client_ts: v.clientTs,
  });
}

export function finalizarOP(v: ApontarVars): Promise<string> {
  return callRpc('fn_pcp_finalizar_apontamento', {
    p_event_id: v.eventId, p_op_id: v.opId, p_device_id: v.deviceId,
    p_device_seq: v.deviceSeq, p_client_ts: v.clientTs,
  });
}

export function registrarConsumo(v: ConsumoVars): Promise<string> {
  return callRpc('fn_pcp_registrar_evento', {
    p_event_id: v.eventId, p_op_id: v.opId, p_tipo: 'consumo_mp', p_device_id: v.deviceId,
    p_device_seq: v.deviceSeq, p_client_ts: v.clientTs, p_motivo: v.motivo,
    p_componente: v.componenteCodigo, p_quantidade: v.quantidade, p_unidade: v.unidade,
    p_nota: v.nota ?? null,
  });
}

export function registrarRefugo(v: RefugoVars): Promise<string> {
  return callRpc('fn_pcp_registrar_evento', {
    p_event_id: v.eventId, p_op_id: v.opId, p_tipo: 'refugo', p_device_id: v.deviceId,
    p_device_seq: v.deviceSeq, p_client_ts: v.clientTs, p_quantidade: v.quantidade, p_nota: v.nota ?? null,
  });
}
