import { supabase } from '@/integrations/supabase/client';

export interface ConfirmUnitVars {
  nfeId: string;
  itemId: string;
  userId: string | null;
  loteNumero: string;
  loteFabricacao: string | null;
  loteValidade: string;
  metodoLeitura: string;
  newConferida: number;
  newStatusItem: string; // 'em_conferencia' | 'conferido'
  updateNfeStatusToEmConferencia: boolean; // true se NFE era 'pendente'
}

/**
 * Encapsula as 3-4 mutations de `handleConfirmUnit` numa única operação
 * idempotente o suficiente pra processar offline-then-online.
 *
 * Notas de idempotência:
 * - INSERT de nfe_lotes_escaneados pode duplicar se rodar 2x (sem unique constraint
 *   conhecido nas escaneamentos). Aceita pq UPDATEs subsequentes da fila refazem
 *   counts; conflict é detectável visualmente pelo conferente.
 * - UPDATE de quantidade_conferida usa valor absoluto (newConferida), então rodar
 *   2x com mesmo valor não duplica contagem.
 * - UPDATE de status_item idem (absoluto).
 * - UPDATE de nfe_recebimentos status só roda se ainda era 'pendente' — idempotente.
 */
export async function confirmUnit(vars: ConfirmUnitVars): Promise<{ ok: true }> {
  const { error: e1 } = await supabase
    .from('nfe_lotes_escaneados')
    .insert({
      nfe_recebimento_id: vars.nfeId,
      nfe_recebimento_item_id: vars.itemId,
      numero_lote: vars.loteNumero,
      data_fabricacao: vars.loteFabricacao,
      data_validade: vars.loteValidade,
      metodo_leitura: vars.metodoLeitura,
      escaneado_por: vars.userId,
    });
  if (e1) throw e1;

  const { error: e2 } = await supabase
    .from('nfe_recebimento_itens')
    .update({
      quantidade_conferida: vars.newConferida,
      status_item: vars.newStatusItem,
    })
    .eq('id', vars.itemId);
  if (e2) throw e2;

  if (vars.updateNfeStatusToEmConferencia) {
    const { error: e3 } = await supabase
      .from('nfe_recebimentos')
      .update({ status: 'em_conferencia' })
      .eq('id', vars.nfeId);
    if (e3) throw e3;
  }

  return { ok: true };
}
