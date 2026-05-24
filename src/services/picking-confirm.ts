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

/**
 * Confirma a separação de um item de picking. Idempotente o suficiente pra
 * replay offline-then-online:
 *  - evento de auditoria usa `id = eventId` (PK) como chave anti-replay; 23505 = já aplicado.
 *  - UPDATE do item usa valores ABSOLUTOS (rodar 2x com mesmo payload não superconta).
 */
export async function confirmPickItem(vars: ConfirmPickItemVars): Promise<{ ok: true }> {
  const divergente =
    vars.loteInformado != null &&
    vars.loteEsperado != null &&
    vars.loteInformado !== vars.loteEsperado;
  const eventType = divergente ? 'lote_divergente' : 'item_confirmado';

  const { error: e1 } = await supabase.from('picking_events').insert({
    id: vars.eventId,
    picking_task_id: vars.pickingTaskId,
    picking_task_item_id: vars.pickingTaskItemId,
    event_type: eventType,
    lote_esperado: vars.loteEsperado,
    lote_informado: vars.loteInformado,
    justificativa: vars.justificativa,
    user_id: vars.userId,
  });
  // 23505 = unique_violation (replay do mesmo eventId) → idempotente, segue.
  if (e1 && (e1 as { code?: string }).code !== '23505') throw e1;

  const status = vars.quantidadeSeparada >= vars.quantidade ? 'concluido' : 'em_andamento';
  const { error: e2 } = await supabase
    .from('picking_task_items')
    .update({
      quantidade_separada: vars.quantidadeSeparada,
      status,
      lote_separado: vars.loteInformado,
      justificativa_substituicao: vars.justificativa,
      separado_at: vars.confirmedAt,
    })
    .eq('id', vars.pickingTaskItemId);
  if (e2) throw e2;

  return { ok: true };
}
