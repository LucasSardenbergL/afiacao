import { supabase } from '@/integrations/supabase/client';
import { comNulo } from '@/lib/rpc-args';

// As RPCs do PCP F1B-M1 estão no types.ts: cada chamada é tipada pelo nome real (antes um
// `RpcClient` local com `rpc(fn: string, …)` desligava argumento e retorno das três).

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

interface RefugoVars extends ApontarVars {
  quantidade: number;
  nota?: string | null;
}

type Cliente = typeof supabase;

/** A RPC devolve o estado projetado da OP (texto); `data` NULL vira '' como antes. */
function estado(res: { data: string | null; error: unknown }): string {
  if (res.error) throw res.error;
  return res.data ?? '';
}

async function iniciarOP(v: ApontarVars, cliente: Cliente = supabase): Promise<string> {
  return estado(await cliente.rpc('fn_pcp_iniciar_apontamento', {
    p_event_id: v.eventId, p_op_id: v.opId, p_device_id: v.deviceId,
    p_device_seq: v.deviceSeq, p_client_ts: v.clientTs,
  }));
}

async function finalizarOP(v: ApontarVars, cliente: Cliente = supabase): Promise<string> {
  return estado(await cliente.rpc('fn_pcp_finalizar_apontamento', {
    p_event_id: v.eventId, p_op_id: v.opId, p_device_id: v.deviceId,
    p_device_seq: v.deviceSeq, p_client_ts: v.clientTs,
  }));
}

// `p_nota` NULL = sem nota (DEFAULT NULL na prod): vai explícito, como antes.
async function registrarConsumo(v: ConsumoVars, cliente: Cliente = supabase): Promise<string> {
  return estado(await cliente.rpc('fn_pcp_registrar_evento', comNulo<'fn_pcp_registrar_evento', 'p_nota'>({
    p_event_id: v.eventId, p_op_id: v.opId, p_tipo: 'consumo_mp', p_device_id: v.deviceId,
    p_device_seq: v.deviceSeq, p_client_ts: v.clientTs, p_motivo: v.motivo,
    p_componente: v.componenteCodigo, p_quantidade: v.quantidade, p_unidade: v.unidade,
    p_nota: v.nota ?? null,
  })));
}

async function registrarRefugo(v: RefugoVars, cliente: Cliente = supabase): Promise<string> {
  return estado(await cliente.rpc('fn_pcp_registrar_evento', comNulo<'fn_pcp_registrar_evento', 'p_nota'>({
    p_event_id: v.eventId, p_op_id: v.opId, p_tipo: 'refugo', p_device_id: v.deviceId,
    p_device_seq: v.deviceSeq, p_client_ts: v.clientTs, p_quantidade: v.quantidade, p_nota: v.nota ?? null,
  })));
}

// Ação discriminada que trafega pela fila offline (um único kind 'pcp.apontar').
export type AcaoApontamento =
  | ({ acao: 'iniciar' } & ApontarVars)
  | ({ acao: 'finalizar' } & ApontarVars)
  | ({ acao: 'consumo' } & ConsumoVars)
  | ({ acao: 'refugo' } & RefugoVars);

/**
 * Despacha para a RPC certa. Compartilhada entre a mutação online e o handler de drenagem
 * offline (registrado no BOOT, em offline-handlers.ts — não só com a tela aberta).
 * `cliente`: no flush offline, o cliente VINCULADO ao token do dono do item.
 */
export async function despacharApontamento(a: AcaoApontamento, cliente: Cliente = supabase): Promise<string> {
  switch (a.acao) {
    case 'iniciar': return iniciarOP(a, cliente);
    case 'finalizar': return finalizarOP(a, cliente);
    case 'consumo': return registrarConsumo(a, cliente);
    case 'refugo': return registrarRefugo(a, cliente);
  }
}
