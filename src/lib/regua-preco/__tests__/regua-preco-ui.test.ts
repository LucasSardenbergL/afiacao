import { describe, it, expect } from 'vitest';
import { dedupeFetchItens, montarInputRegua, chaveFetch, CAPS_REGUA } from '../regua-preco-ui';
import type { FetchDataRegua, ReguaCartItem } from '../regua-preco-ui';

const item = (over: Partial<ReguaCartItem> = {}): ReguaCartItem => ({
  chave: 'oben:101:', productId: 'p1', qty: 2, precoAtual: 106, ...over,
});

describe('dedupeFetchItens', () => {
  it('colapsa mesmo (productId, qty) numa única busca', () => {
    const r = dedupeFetchItens([item(), item({ chave: 'oben:101:x' }), item({ productId: 'p2' })]);
    expect(r).toHaveLength(2);
    expect(r.map(chaveFetch).sort()).toEqual(['p1:2', 'p2:2']);
  });
  it('descarta itens sem productId, qty<=0 ou preço<=0', () => {
    expect(dedupeFetchItens([
      item({ productId: '' }), item({ qty: 0 }), item({ precoAtual: 0 }),
    ])).toHaveLength(0);
  });
});

describe('montarInputRegua', () => {
  const fetch: FetchDataRegua = {
    cmc: 98, cmc_confiavel: true, aliquota_venda: 0.078, piso_mc: 106.29,
    precos_cliente: [112, 110], comparaveis: [{ preco: 120, c: 1 }, { preco: 125, c: 2 }],
  };
  it('mapeia comparaveis {preco,c} → {preco,clienteId} e injeta CAPS', () => {
    const inp = montarInputRegua(fetch, 106);
    expect(inp.precoAtual).toBe(106);
    expect(inp.cmc).toBe(98);
    expect(inp.cmcConfiavel).toBe(true);
    expect(inp.aliquotaVenda).toBe(0.078);
    expect(inp.precosCliente).toEqual([112, 110]);
    expect(inp.comparaveis).toEqual([{ preco: 120, clienteId: '1' }, { preco: 125, clienteId: '2' }]);
    expect(inp.caps).toBe(CAPS_REGUA);
  });
  it('tolera arrays nulos vindos da RPC (degrada p/ vazio)', () => {
    const inp = montarInputRegua({ ...fetch, precos_cliente: null as never, comparaveis: null as never }, 106);
    expect(inp.precosCliente).toEqual([]);
    expect(inp.comparaveis).toEqual([]);
  });
});
