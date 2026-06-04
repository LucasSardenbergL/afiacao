import { supabase } from '@/integrations/supabase/client';

export interface ConfirmPickItemVars {
  /** crypto.randomUUID() gerado no bipe — chave de idempotência do evento. */
  eventId: string;
  pickingTaskId: string;
  pickingTaskItemId: string;
  userId: string | null;
  /** Quantidade esperada do item (pra derivar status). */
  quantidade: number;
  /** Quantidade separada ABSOLUTA (nunca incremento). */
  quantidadeSeparada: number;
  loteEsperado: string | null;
  loteInformado: string | null;
  justificativa: string | null;
  /** ISO timestamp. */
  confirmedAt: string;
}

// route_*/picking RPCs não estão no types gerado → cast do client (mesmo padrão de useRegistrarContato).
type RpcClient = { rpc(fn: string, p?: Record<string, unknown>): Promise<{ error: { message: string } | null }> };

/**
 * Confirma a separação de um item de picking via RPC atômica `confirmar_item_picking`
 * (evento de auditoria + UPDATE absoluto do item + recálculo da task-pai, numa transação).
 * Idempotente pra replay offline-then-online:
 *  - o evento usa `id = eventId` (PK) com `ON CONFLICT DO NOTHING` server-side;
 *  - o UPDATE do item é ABSOLUTO (rodar 2x com mesmo payload não superconta);
 *  - o recálculo do pai é função pura do estado atual dos itens.
 * `userId` é derivado server-side (`auth.uid()`); `quantidade`/`loteEsperado` da interface seguem
 * no payload (usados pelo optimistic-merge) mas a RPC lê o item server-side (anti-spoof).
 */
export async function confirmPickItem(vars: ConfirmPickItemVars): Promise<{ ok: true }> {
  const { error } = await (supabase as unknown as RpcClient).rpc('confirmar_item_picking', {
    p_event_id: vars.eventId,
    p_task_id: vars.pickingTaskId,
    p_item_id: vars.pickingTaskItemId,
    p_quantidade_separada: vars.quantidadeSeparada,
    p_lote_informado: vars.loteInformado,
    p_justificativa: vars.justificativa,
    p_confirmed_at: vars.confirmedAt,
  });
  if (error) throw error;
  return { ok: true };
}
