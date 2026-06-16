import type { ConfirmPickItemVars } from '@/services/picking-confirm';

/** Campos mínimos que o merge precisa numa linha de picking_task_items. */
interface MergeableItem {
  id: string;
  quantidade: number;
  quantidade_separada: number;
  status: string;
  lote_separado: string | null;
  separado_at: string | null;
}

/**
 * Mescla confirms de picking enfileirados (offline) sobre as linhas do servidor.
 * Valores ABSOLUTOS; quando há mais de um pendente pro mesmo item, o último da fila vence.
 * Retorna a lista mesclada (tipo inalterado) + os ids com sync pendente.
 */
export function applyQueuedPickConfirms<T extends MergeableItem>(
  serverItems: T[],
  queued: ConfirmPickItemVars[],
): { items: T[]; pendingIds: Set<string> } {
  const byItem = new Map<string, ConfirmPickItemVars>();
  for (const q of queued) byItem.set(q.pickingTaskItemId, q); // ordem de enfileiramento → último vence
  const pendingIds = new Set<string>();
  const items = serverItems.map((it) => {
    const p = byItem.get(it.id);
    if (!p) return it;
    pendingIds.add(it.id);
    return {
      ...it,
      quantidade_separada: p.quantidadeSeparada,
      status: p.quantidadeSeparada >= it.quantidade ? 'concluido' : 'em_andamento',
      lote_separado: p.loteInformado,
      separado_at: p.confirmedAt,
    };
  });
  return { items, pendingIds };
}
