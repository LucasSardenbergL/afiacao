import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  encerrarEnvio, estadoDoPedido, iniciarEnvio, limparRegistroParaTeste, marcarDivergente,
  marcarPendente, resolverPendente, tokensPendentes,
} from '../registroEnvios';
import { invalidarCachesDoPedido } from '../envioEdicao';

const ID = '2f8a04c9-2daf-4cf9-bdbf-047d16765ea7';

describe('registroEnvios — um envio por pedido, chave canônica (Codex 2026-11-26)', () => {
  beforeEach(() => limparRegistroParaTeste());

  it('aquisição: o 2º iniciarEnvio do mesmo pedido falha até o 1º encerrar', () => {
    expect(iniciarEnvio(ID)).toBe(true);
    expect(iniciarEnvio(ID)).toBe(false);
    encerrarEnvio(ID);
    expect(iniciarEnvio(ID)).toBe(true);
  });

  it('UUID em maiúsculas é o MESMO pedido (rota aceita, banco devolve minúsculas)', () => {
    expect(iniciarEnvio(ID)).toBe(true);
    expect(iniciarEnvio(ID.toUpperCase())).toBe(false);
    expect(estadoDoPedido(ID.toUpperCase()).emVoo).toBe(true);
    marcarDivergente(ID);
    expect(estadoDoPedido(ID.toUpperCase()).divergente).toBe(true);
  });
});

describe('registroEnvios — grafias do UUID e divergente recusa envio', () => {
  beforeEach(() => limparRegistroParaTeste());

  it('sem hífens e entre chaves é o MESMO pedido', () => {
    marcarDivergente(ID);
    expect(estadoDoPedido(ID.replace(/-/g, '')).divergente).toBe(true);
    expect(estadoDoPedido(`{${ID.toUpperCase()}}`).divergente).toBe(true);
  });

  it('pedido divergente não adquire envio, em nenhuma grafia', () => {
    marcarDivergente(ID);
    expect(iniciarEnvio(ID.replace(/-/g, ''))).toBe(false);
  });
});

describe('pendentes da aba (leva 1 PR 2)', () => {
  beforeEach(() => limparRegistroParaTeste());

  it('marca, lista pela chave canônica e resolve um a um', () => {
    marcarPendente(ID, 'tok-a');
    marcarPendente(ID.toUpperCase(), 'tok-b');
    expect(tokensPendentes(ID).sort()).toEqual(['tok-a', 'tok-b']);
    resolverPendente(ID, 'tok-a');
    expect(tokensPendentes(ID)).toEqual(['tok-b']);
    resolverPendente(ID, 'tok-b');
    expect(tokensPendentes(ID)).toEqual([]);
  });

  it('não toca o localStorage (compartilhado entre abas — Codex r5)', () => {
    const toques: string[] = [];
    vi.stubGlobal('localStorage', {
      getItem: () => { toques.push('get'); return null; },
      setItem: () => { toques.push('set'); },
      removeItem: () => { toques.push('remove'); },
    });
    try {
      marcarPendente(ID, 'tok-a');
      tokensPendentes(ID);
      resolverPendente(ID, 'tok-a');
      expect(toques).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('invalidarCachesDoPedido — UUID canônico (Codex r4)', () => {
  it('a rota em maiúsculas invalida o detalhe e os descontos guardados com o id do banco', async () => {
    const predicados: Array<(q: { queryKey: readonly unknown[] }) => boolean> = [];
    const qc = {
      cancelQueries: async () => {},
      invalidateQueries: async (f: { predicate?: (q: { queryKey: readonly unknown[] }) => boolean }) => { if (f.predicate) predicados.push(f.predicate); },
    };
    await invalidarCachesDoPedido(qc as never, ID.toUpperCase());
    expect(predicados).toHaveLength(2);
    expect(predicados[0]({ queryKey: ['order-detail', 'u', 'app', ID] })).toBe(true);
    expect(predicados[1]({ queryKey: ['order-descontos-itens', 'u', ID] })).toBe(true);
    expect(predicados[0]({ queryKey: ['order-detail', 'u', 'app', '00000000-0000-0000-0000-000000000000'] })).toBe(false);
    expect(predicados[0]({ queryKey: ['order-detail', 'u', 'app', undefined] })).toBe(false);
  });
});
