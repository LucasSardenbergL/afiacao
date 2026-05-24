import { describe, it, expect } from 'vitest';
import { applyQueuedPickConfirms } from '../optimistic-merge';
import type { ConfirmPickItemVars } from '@/services/picking-confirm';

type Row = {
  id: string;
  quantidade: number;
  quantidade_separada: number;
  status: string;
  lote_separado: string | null;
  separado_at: string | null;
};

const server: Row[] = [
  { id: 'a', quantidade: 10, quantidade_separada: 0, status: 'pendente', lote_separado: null, separado_at: null },
  { id: 'b', quantidade: 5, quantidade_separada: 0, status: 'pendente', lote_separado: null, separado_at: null },
];

function pend(itemId: string, qtd: number, lote: string | null, at: string): ConfirmPickItemVars {
  return {
    eventId: 'e', pickingTaskId: 't', pickingTaskItemId: itemId, userId: null,
    quantidade: 0, quantidadeSeparada: qtd, loteEsperado: null, loteInformado: lote, justificativa: null, confirmedAt: at,
  };
}

describe('applyQueuedPickConfirms', () => {
  it('sobrepõe item com confirm pendente e marca pendingIds', () => {
    const { items, pendingIds } = applyQueuedPickConfirms(server, [pend('a', 10, 'L1', 'T1')]);
    const a = items.find((i) => i.id === 'a')!;
    expect(a.quantidade_separada).toBe(10);
    expect(a.status).toBe('concluido');
    expect(a.lote_separado).toBe('L1');
    expect(a.separado_at).toBe('T1');
    expect(pendingIds.has('a')).toBe(true);
    expect(pendingIds.has('b')).toBe(false);
  });

  it('item sem pendente fica intacto', () => {
    const { items } = applyQueuedPickConfirms(server, [pend('a', 10, 'L1', 'T1')]);
    expect(items.find((i) => i.id === 'b')).toEqual(server[1]);
  });

  it('parcial deriva em_andamento', () => {
    const { items } = applyQueuedPickConfirms(server, [pend('b', 2, null, 'T1')]);
    expect(items.find((i) => i.id === 'b')!.status).toBe('em_andamento');
  });

  it('dois confirms pro mesmo item: o último da fila vence', () => {
    const { items } = applyQueuedPickConfirms(server, [pend('a', 3, 'L1', 'T1'), pend('a', 10, 'L2', 'T2')]);
    const a = items.find((i) => i.id === 'a')!;
    expect(a.quantidade_separada).toBe(10);
    expect(a.lote_separado).toBe('L2');
  });
});
