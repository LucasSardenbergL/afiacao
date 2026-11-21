import { describe, it, expect } from 'vitest';
import { estadoDoCatalogo, estadoListaProdutos } from '../estado-lista-produtos';

describe('estadoDoCatalogo — falhou ≠ vazio', () => {
  const q = (o: Partial<Parameters<typeof estadoDoCatalogo>[0]>) =>
    estadoDoCatalogo({ isPending: false, isError: false, isFetching: false, temDados: false, ...o });

  it('primeiro carregamento → carregando', () => expect(q({ isPending: true, isFetching: true })).toBe('carregando'));
  it('erro sem dado → falhou', () => expect(q({ isError: true })).toBe('falhou'));
  it('erro sem dado, tentando de novo → carregando', () => expect(q({ isError: true, isFetching: true })).toBe('carregando'));
  it('erro COM dado em mãos (refetch falhou) → ok, a lista vale', () => expect(q({ isError: true, temDados: true })).toBe('ok'));
  it('sucesso → ok', () => expect(q({ temDados: true })).toBe('ok'));
});

describe('estadoListaProdutos', () => {
  it('catálogo falhou com busca digitada → falhou, nunca "sem resultado"', () => {
    expect(estadoListaProdutos({ catalogo: 'falhou', quantidade: 0, termo: 'lixa' })).toBe('falhou');
  });
  it('catálogo ok, busca sem casamento → sem_resultado', () => {
    expect(estadoListaProdutos({ catalogo: 'ok', quantidade: 0, termo: 'lixa' })).toBe('sem_resultado');
  });
  it('catálogo ok, sem termo e sem produto → catalogo_vazio', () => {
    expect(estadoListaProdutos({ catalogo: 'ok', quantidade: 0, termo: '  ' })).toBe('catalogo_vazio');
  });
  it('com produtos → lista', () => {
    expect(estadoListaProdutos({ catalogo: 'ok', quantidade: 3, termo: 'lixa' })).toBe('lista');
  });
  it('carregando → carregando', () => {
    expect(estadoListaProdutos({ catalogo: 'carregando', quantidade: 0, termo: '' })).toBe('carregando');
  });
});
