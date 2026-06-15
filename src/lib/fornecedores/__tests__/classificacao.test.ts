import { describe, it, expect } from 'vitest';
import { TAGS_NAO_CLIENTE, temTagNaoCliente, deveExcluirDaCarteira } from '../classificacao';

describe('temTagNaoCliente', () => {
  it('detecta Fornecedor com case/acento variável', () => {
    expect(temTagNaoCliente(['Fornecedor'])).toBe(true);
    expect(temTagNaoCliente(['FORNECEDOR'])).toBe(true);
    expect(temTagNaoCliente([' transportadora '])).toBe(true);
  });
  it('cliente comum não tem tag', () => {
    expect(temTagNaoCliente(['Cliente VIP', 'Moveleiro'])).toBe(false);
    expect(temTagNaoCliente([])).toBe(false);
    expect(temTagNaoCliente(null as unknown as string[])).toBe(false);
  });
  it('TAGS_NAO_CLIENTE é a lista canônica', () => {
    expect(TAGS_NAO_CLIENTE).toEqual(['fornecedor', 'transportadora']);
  });
});

describe('deveExcluirDaCarteira', () => {
  it('fornecedor sem exceção → exclui', () => {
    expect(deveExcluirDaCarteira({ tags: ['Fornecedor'], isExcecao: false })).toBe(true);
  });
  it('fornecedor COM exceção (cliente real) → mantém', () => {
    expect(deveExcluirDaCarteira({ tags: ['Fornecedor'], isExcecao: true })).toBe(false);
  });
  it('não-fornecedor → mantém (independe de exceção)', () => {
    expect(deveExcluirDaCarteira({ tags: ['Cliente'], isExcecao: false })).toBe(false);
  });
});
