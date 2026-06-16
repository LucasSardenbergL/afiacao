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
  it('fornecedor sem venda, sem exceção → exclui', () => {
    expect(deveExcluirDaCarteira({ tags: ['Fornecedor'], temVendaReal: false, isExcecao: false })).toBe(true);
  });
  it('fornecedor COM venda real → mantém (é cliente: regra A)', () => {
    expect(deveExcluirDaCarteira({ tags: ['Fornecedor'], temVendaReal: true, isExcecao: false })).toBe(false);
  });
  it('fornecedor COM exceção curada → mantém', () => {
    expect(deveExcluirDaCarteira({ tags: ['Fornecedor'], temVendaReal: false, isExcecao: true })).toBe(false);
  });
  it('não-fornecedor → mantém (independe de venda/exceção)', () => {
    expect(deveExcluirDaCarteira({ tags: ['Cliente'], temVendaReal: false, isExcecao: false })).toBe(false);
  });
});
