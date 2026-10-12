/**
 * @vitest-environment jsdom
 *
 * Exceção ao particionamento por extensão (`projects` em vitest.config.ts): `.ts`, logo `node`
 * por padrão, mas a fila vive no localStorage do browser.
 *
 * Fila offline com DONO — dois usuários no MESMO aparelho. Cenário do bug: A confirma offline,
 * sai; B entra; a rede volta; o flush enviava o item de A com a sessão de B.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import {
  contarFila,
  enqueue,
  FilaOfflineSemDonoError,
  flush,
  getOfflineQueueDepth,
  getQueuedByKind,
  type QueuedMutation,
} from '../offline-queue';

const A = 'user-a';
const B = 'user-b';
const V2 = 'offline_queue_v2';
const V1 = 'offline_queue_v1';

type Cred = { userId: string };
/** Credencial trocável: simula quem está logado no aparelho a cada leitura. */
function sessao(inicial: string | null) {
  let atual: string | null = inicial;
  return {
    trocarPara: (u: string | null) => { atual = u; },
    ler: vi.fn(async (): Promise<Cred | null> => (atual === null ? null : { userId: atual })),
  };
}

function filaCrua(): QueuedMutation[] {
  return JSON.parse(localStorage.getItem(V2) ?? '[]');
}

beforeEach(() => localStorage.clear());

describe('fila offline com dono — dois usuários no mesmo aparelho', () => {
  it('item de A NÃO sai com a sessão de B; fica intacto e sai quando A volta', async () => {
    await enqueue('recebimento.confirm-unit', { item: 1 }, A);
    const s = sessao(B);
    const handler = vi.fn(async () => true);

    const r1 = await flush(handler, s.ler);

    expect(handler).not.toHaveBeenCalled();
    expect(r1).toEqual({ success: 0, failed: 0, retidos: 1 });
    // Retido INTACTO: sem attempts++ nem lastError (não é falha, é dono diferente).
    expect(filaCrua()).toEqual([
      expect.objectContaining({ userId: A, attempts: 0, variables: { item: 1 } }),
    ]);
    expect(filaCrua()[0].lastError).toBeUndefined();

    s.trocarPara(A);
    const r2 = await flush(handler, s.ler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ userId: A }), { userId: A });
    expect(r2).toEqual({ success: 1, failed: 0, retidos: 0 });
    expect(await getOfflineQueueDepth()).toBe(0);
  });

  it('na mesma rodada, B envia só o que é de B e retém o de A (controle positivo)', async () => {
    await enqueue('k', { de: 'A' }, A);
    await enqueue('k', { de: 'B' }, B);
    const handler = vi.fn(async (_m: QueuedMutation, _c: Cred) => true);

    const r = await flush(handler, sessao(B).ler);

    expect(handler.mock.calls.map(([m]) => m.userId)).toEqual([B]);
    expect(r).toEqual({ success: 1, failed: 0, retidos: 1 });
    expect(filaCrua().map((m) => m.userId)).toEqual([A]);
  });

  it('sem sessão (logout) ou leitura da credencial falhando: nada sai, nada é penalizado', async () => {
    await enqueue('k', { n: 1 }, A);
    const handler = vi.fn(async () => true);

    await flush(handler, sessao(null).ler);
    await flush(handler, async () => { throw new Error('storage bloqueado'); });

    expect(handler).not.toHaveBeenCalled();
    expect(filaCrua()).toEqual([expect.objectContaining({ userId: A, attempts: 0 })]);
  });

  it('sessão troca de A para B NO MEIO do flush: os itens seguintes de A param ali', async () => {
    await enqueue('k', { n: 1 }, A);
    await enqueue('k', { n: 2 }, A);
    const s = sessao(A);
    const handler = vi.fn(async () => {
      s.trocarPara(B); // A sai e B entra enquanto o 1º item está em voo
      return true;
    });

    const r = await flush(handler, s.ler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ success: 1, failed: 0, retidos: 1 });
    expect(filaCrua().map((m) => m.variables)).toEqual([{ n: 2 }]);
    // A credencial foi relida ANTES DE CADA item, não uma vez por rodada.
    expect(s.ler).toHaveBeenCalledTimes(2);
  });

  it('enqueue sem dono LANÇA e não grava nada', async () => {
    await expect(enqueue('k', { n: 1 }, '')).rejects.toBeInstanceOf(FilaOfflineSemDonoError);
    await expect(enqueue('k', { n: 1 }, undefined as unknown as string)).rejects.toThrow(
      'fila-offline: enqueue sem usuário',
    );
    expect(await getOfflineQueueDepth()).toBe(0);
  });
});

describe('itens legados (v1, sem dono)', () => {
  it('v1 é só LIDA: contados como sem dono, nunca enviados por ninguém, nunca apagados', async () => {
    const v1 = JSON.stringify([
      { id: 'leg-1', kind: 'recebimento.confirm-unit', variables: { x: 1 }, enqueuedAt: 'x', attempts: 0 },
      // Um `userId` vindo da v1 NÃO é aceito: nenhum build antigo atestou dono.
      { id: 'leg-2', kind: 'picking.confirm-item', variables: { x: 2 }, enqueuedAt: 'x', attempts: 3, userId: A },
    ]);
    localStorage.setItem(V1, v1);
    const handler = vi.fn(async () => true);

    await flush(handler, sessao(A).ler);
    await flush(handler, sessao(B).ler);

    expect(handler).not.toHaveBeenCalled();
    // Byte a byte: nada reescrito, nada removido, nada copiado para a v2.
    expect(localStorage.getItem(V1)).toBe(v1);
    expect(filaCrua()).toEqual([]);
    expect(contarFila(A)).toEqual({ meus: 0, retidos: 2, deOutros: 0, semDono: 2 });
    expect(await getOfflineQueueDepth()).toBe(2);
    expect(getQueuedByKind('picking.confirm-item', A)).toEqual([]);
  });

  it('build antigo gravando a v1 e enqueue na v2 não se atropelam (nenhuma escrita cruzada)', async () => {
    localStorage.setItem(V1, JSON.stringify([{ id: 'leg-3', kind: 'k', variables: { n: 'velho' }, enqueuedAt: 'x', attempts: 0 }]));
    expect(contarFila(A).semDono).toBe(1); // leitura no meio: antes migrava (lia+regravava as duas)
    await enqueue('k', { n: 'novo' }, A);
    // O build antigo acrescenta outro item à v1 depois da nossa leitura.
    localStorage.setItem(V1, JSON.stringify([
      { id: 'leg-3', kind: 'k', variables: { n: 'velho' }, enqueuedAt: 'x', attempts: 0 },
      { id: 'leg-4', kind: 'k', variables: { n: 'velho-2' }, enqueuedAt: 'x', attempts: 0 },
    ]));

    expect(contarFila(A)).toEqual({ meus: 1, retidos: 2, deOutros: 0, semDono: 2 });
    expect(filaCrua().map((m) => m.variables)).toEqual([{ n: 'novo' }]);
  });

  it('item SEM dono dentro da v2 (corrompido) também nunca é adotado', async () => {
    localStorage.setItem(V2, JSON.stringify([{ id: 'x', kind: 'k', variables: {}, enqueuedAt: 'x', attempts: 0 }]));
    const handler = vi.fn(async () => true);

    const r = await flush(handler, sessao(A).ler);

    expect(handler).not.toHaveBeenCalled();
    expect(r).toEqual({ success: 0, failed: 0, retidos: 1 });
    expect(filaCrua()).toHaveLength(1);
  });
});

describe('leitura por dono', () => {
  it('contarFila separa meus / de outros / sem dono, e o total não perde ninguém', async () => {
    await enqueue('k', {}, A);
    await enqueue('k', {}, A);
    await enqueue('k', {}, B);
    localStorage.setItem(V1, JSON.stringify([{ id: 'l', kind: 'k', variables: {}, enqueuedAt: 'x', attempts: 0 }]));

    expect(contarFila(A)).toEqual({ meus: 2, retidos: 2, deOutros: 1, semDono: 1 });
    expect(contarFila(B)).toEqual({ meus: 1, retidos: 3, deOutros: 2, semDono: 1 });
    expect(contarFila(null)).toEqual({ meus: 0, retidos: 4, deOutros: 3, semDono: 1 });
    expect(await getOfflineQueueDepth()).toBe(4);
  });

  it('getQueuedByKind só devolve os itens do dono (overlay do picking não mostra o de outro)', async () => {
    await enqueue('picking.confirm-item', { de: 'A' }, A);
    await enqueue('picking.confirm-item', { de: 'B' }, B);

    expect(getQueuedByKind('picking.confirm-item', B).map((m) => m.variables)).toEqual([{ de: 'B' }]);
    expect(getQueuedByKind('picking.confirm-item', null)).toEqual([]);
  });
});

describe('uma rodada de flush por vez', () => {
  it('duas rodadas simultâneas despacham cada item UMA vez', async () => {
    await enqueue('k', { n: 1 }, A);
    let soltar!: () => void;
    const portao = new Promise<void>((r) => { soltar = r; });
    const handler = vi.fn(async () => {
      await portao;
      return true;
    });

    const p1 = flush(handler, sessao(A).ler);
    const p2 = flush(handler, sessao(A).ler);
    soltar();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect([r1.emCurso, r2.emCurso]).toEqual([undefined, true]);
    expect(await getOfflineQueueDepth()).toBe(0);
  });
});
