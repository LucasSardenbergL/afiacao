import { supabase } from '@/integrations/supabase/client';
import type { TablesInsert, TablesUpdate } from '@/integrations/supabase/types';

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
 *
 * O lote NÃO leva a NF-e: `nfe_lotes_escaneados` não tem essa coluna — o lote liga ao item
 * (`nfe_recebimento_item_id`) e o item à NF-e. O insert levava `nfe_recebimento_id` e o
 * PostgREST respondia PGRST204 em TODA unidade confirmada; o typecheck não via porque o
 * `insert` do postgrest-js é genérico (`Row extends Insert`) e aceita coluna a mais calado.
 * Os `satisfies` abaixo devolvem essa checagem. `nfeId` segue nas vars (contrato da fila
 * `offline_queue_v1`) porque a promoção da NF-e a 'em_conferencia' precisa dele.
 */
export async function confirmUnit(vars: ConfirmUnitVars): Promise<{ ok: true }> {
  const { error: e1 } = await supabase
    .from('nfe_lotes_escaneados')
    .insert({
      nfe_recebimento_item_id: vars.itemId,
      numero_lote: vars.loteNumero,
      data_fabricacao: vars.loteFabricacao,
      data_validade: vars.loteValidade,
      metodo_leitura: vars.metodoLeitura,
      escaneado_por: vars.userId,
    } satisfies TablesInsert<'nfe_lotes_escaneados'>);
  if (e1) throw e1;

  const { error: e2 } = await supabase
    .from('nfe_recebimento_itens')
    .update({
      quantidade_conferida: vars.newConferida,
      status_item: vars.newStatusItem,
    } satisfies TablesUpdate<'nfe_recebimento_itens'>)
    .eq('id', vars.itemId);
  if (e2) throw e2;

  if (vars.updateNfeStatusToEmConferencia) {
    const { error: e3 } = await supabase
      .from('nfe_recebimentos')
      .update({ status: 'em_conferencia' } satisfies TablesUpdate<'nfe_recebimentos'>)
      .eq('id', vars.nfeId);
    if (e3) throw e3;
  }

  return { ok: true };
}
