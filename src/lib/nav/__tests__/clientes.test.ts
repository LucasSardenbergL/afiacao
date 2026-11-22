import { describe, it, expect } from 'vitest';
import {
  estadoComOrigem, lerOrigemLista, lerRolagemARestaurar, montarOrigemLista, queryDaFila, urlCliente360, urlCadastroCliente,
  urlListaClientes, urlNovoPedido, urlPedidosDoCliente,
} from '../clientes';

describe('queryDaFila — só busca, saúde e ordem viajam', () => {
  it('mantém os 3 parâmetros da fila, em ordem fixa, e descarta o resto', () => {
    expect(queryDaFila('?ordem=nome&utm=x&health=critico&search=joão')).toBe('?search=jo%C3%A3o&health=critico&ordem=nome');
  });
  it('sem `?`, vazio ou só valores vazios → ""', () => {
    expect(queryDaFila('health=atencao')).toBe('?health=atencao');
    expect(queryDaFila('')).toBe('');
    expect(queryDaFila('?search=&health=')).toBe('');
  });
});

describe('URLs', () => {
  it('lista e ficha carregam a fila', () => {
    expect(urlListaClientes('?health=critico&x=1')).toBe('/admin/customers?health=critico');
    expect(urlListaClientes()).toBe('/admin/customers');
    expect(urlCadastroCliente('abc', '?ordem=nome')).toBe('/admin/customers/abc?ordem=nome');
  });
  it('novo pedido e pedidos levam o cliente (antes /sales/new ia sem ele)', () => {
    expect(urlNovoPedido('u-1')).toBe('/sales/new?customer=u-1');
    expect(urlPedidosDoCliente('u-1')).toBe('/sales?customer=u-1');
    expect(urlCliente360('u-1')).toBe('/admin/customers/u-1/360');
  });
  it('id é codificado (nunca injeta segmento/parâmetro)', () => {
    expect(urlNovoPedido('a&b=c')).toBe('/sales/new?customer=a%26b%3Dc');
    expect(urlCadastroCliente('a/b')).toBe('/admin/customers/a%2Fb');
  });
});

describe('estadoComOrigem — o state que leva a fila adiante (lista → 360 → Cadastro)', () => {
  it('com origem → { origemLista }; sem origem → undefined (nunca state vazio fingindo fila)', () => {
    const origem = montarOrigemLista('?search=ab', 50);
    expect(estadoComOrigem(origem)).toEqual({ origemLista: origem });
    expect(estadoComOrigem(null)).toBeUndefined();
    expect(estadoComOrigem(undefined)).toBeUndefined();
  });
  it('o state montado volta intacto pelo leitor', () => {
    const origem = montarOrigemLista('?health=critico&ordem=nome', 300);
    expect(lerOrigemLista(estadoComOrigem(origem))).toEqual(origem);
  });
});

describe('origem da lista no location.state', () => {
  it('ida e volta', () => {
    const origem = montarOrigemLista('?search=ab&foo=1', 1234.6);
    expect(origem).toEqual({ query: '?search=ab', rolagem: 1235 });
    expect(lerOrigemLista({ origemLista: origem })).toEqual(origem);
  });
  it('state ausente ou torto → null (cai na lista sem filtro)', () => {
    for (const ruim of [null, undefined, 'x', 3, {}, { origemLista: null }, { origemLista: { query: 7 } }]) {
      expect(lerOrigemLista(ruim)).toBeNull();
    }
  });
  it('rolagem inválida vira null, nunca 0 fabricado', () => {
    expect(montarOrigemLista('', Number.NaN).rolagem).toBeNull();
    expect(montarOrigemLista('', -5).rolagem).toBeNull();
    expect(lerOrigemLista({ origemLista: { query: '', rolagem: 'muito' } })).toEqual({ query: '', rolagem: null });
    expect(montarOrigemLista('', 0).rolagem).toBe(0);
  });
  it('rolagem a restaurar', () => {
    expect(lerRolagemARestaurar({ rolagem: 300 })).toBe(300);
    expect(lerRolagemARestaurar({ rolagem: null })).toBeNull();
    expect(lerRolagemARestaurar(null)).toBeNull();
  });
});
