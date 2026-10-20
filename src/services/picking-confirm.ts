import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';

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

type ArgsGerados = Database['public']['Functions']['confirmar_item_picking']['Args'];

/**
 * O gerador do Supabase declara TODO argumento de função como não-nulo, mas
 * `confirmar_item_picking` (sem DEFAULT) aceita NULL em `p_lote_informado`/`p_justificativa` — e o
 * NULL é semântico (sem lote informado não há divergência; conferido em prod 2026-10-20). O objeto
 * é checado inteiro contra `ArgsConfirmar` (derivado do types.ts, com NULL só nessas duas chaves);
 * a asserção final só estreita a nulidade delas. Residual deliberado, mesma classe do raio-X
 * (docs/historico/casts-reposicao.md · casts-estoque-recebimento.md): não há forma tipada de mandar
 * NULL a argumento sem DEFAULT.
 */
type ArgsConfirmar = Omit<ArgsGerados, 'p_lote_informado' | 'p_justificativa'> & {
  p_lote_informado: string | null;
  p_justificativa: string | null;
};

/**
 * Confirma a separação de um item de picking via RPC atômica `confirmar_item_picking`
 * (evento de auditoria + UPDATE absoluto do item + recálculo da task-pai, numa transação).
 * Idempotente pra replay offline-then-online:
 *  - o evento usa `id = eventId` (PK) com `ON CONFLICT DO NOTHING` server-side;
 *  - o UPDATE do item é ABSOLUTO (rodar 2x com mesmo payload não superconta);
 *  - o recálculo do pai é função pura do estado atual dos itens.
 * `userId` é derivado server-side (`auth.uid()`); `quantidade`/`loteEsperado` da interface seguem
 * no payload (usados pelo optimistic-merge) mas a RPC lê o item server-side (anti-spoof).
 *
 * `cliente`: no flush offline, o cliente VINCULADO ao token do dono do item (ver useOfflineFlush).
 */
export async function confirmPickItem(vars: ConfirmPickItemVars, cliente: typeof supabase = supabase): Promise<{ ok: true }> {
  const args: ArgsConfirmar = {
    p_event_id: vars.eventId,
    p_task_id: vars.pickingTaskId,
    p_item_id: vars.pickingTaskItemId,
    p_quantidade_separada: vars.quantidadeSeparada,
    p_lote_informado: vars.loteInformado,
    p_justificativa: vars.justificativa,
    p_confirmed_at: vars.confirmedAt,
  };
  const { error } = await cliente.rpc('confirmar_item_picking', args as ArgsGerados);
  if (error) throw error;
  return { ok: true };
}
