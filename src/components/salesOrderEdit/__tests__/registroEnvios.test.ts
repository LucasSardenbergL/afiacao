import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  encerrarEnvio, esquecerMemoriaParaTeste, estadoDoPedido, iniciarEnvio, limparRegistroParaTeste, marcarDivergente,
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

describe('pendentes persistidos no aparelho (leva 1 PR 2, Codex r3/r4)', () => {
  let memoria: Record<string, string>;
  beforeEach(() => {
    memoria = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in memoria ? memoria[k] : null),
      setItem: (k: string, v: string) => { memoria[k] = v; },
      removeItem: (k: string) => { delete memoria[k]; },
    });
    limparRegistroParaTeste();
    return () => { vi.unstubAllGlobals(); };
  });

  it('um F5 (memória perdida) não perde o token: ele segue no storage até ser resolvido', () => {
    marcarPendente(ID, 'tok-a');
    esquecerMemoriaParaTeste();
    expect(tokensPendentes(ID.toUpperCase())).toEqual(['tok-a']);
    resolverPendente(ID, 'tok-a');
    esquecerMemoriaParaTeste();
    expect(tokensPendentes(ID)).toEqual([]);
  });

  it('duas abas não se sobrescrevem: cada operação relê o storage e mescla', () => {
    marcarPendente(ID, 'tok-a');
    // "outra aba" grava o pendente de OUTRO pedido direto no storage
    const atual = JSON.parse(memoria['afiacao.edicao-pedido.pendentes.v1']) as Record<string, string[]>;
    atual['outro'] = ['tok-b'];
    memoria['afiacao.edicao-pedido.pendentes.v1'] = JSON.stringify(atual);
    marcarPendente(ID, 'tok-c');
    const final = JSON.parse(memoria['afiacao.edicao-pedido.pendentes.v1']) as Record<string, string[]>;
    expect(final['outro']).toEqual(['tok-b']);
    expect(tokensPendentes(ID).sort()).toEqual(['tok-a', 'tok-c']);
  });

  it('storage que lança degrada para a memória da aba (nunca quebra o salvar)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('bloqueado'); },
      setItem: () => { throw new Error('bloqueado'); },
      removeItem: () => { throw new Error('bloqueado'); },
    });
    expect(() => marcarPendente(ID, 'tok-a')).not.toThrow();
    expect(tokensPendentes(ID)).toEqual(['tok-a']);
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
