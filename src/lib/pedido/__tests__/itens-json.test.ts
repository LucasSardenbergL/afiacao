import { describe, it, expect } from 'vitest';
import { itensPedidoDoJson, omiePayloadDoJson } from '../itens-json';

const ITEM = { omie_codigo_produto: 123, descricao: 'Lixa', quantidade: 2, valor_unitario: 10.5, desconto: 0 };

describe('itensPedidoDoJson', () => {
  it('lê o item e PRESERVA chave desconhecida (a edição regrava o jsonb)', () => {
    const [i] = itensPedidoDoJson([{ ...ITEM, chave_nova: 'x' }], 'sales_orders p1');
    expect(i).toEqual({ ...ITEM, chave_nova: 'x' });
  });

  it('opcional ausente continua AUSENTE (não vira chave com undefined)', () => {
    const [i] = itensPedidoDoJson([ITEM], 'sales_orders p1');
    expect('valor_total' in i).toBe(false);
    expect('codigo' in i).toBe(false);
  });

  it('valor_unitario NULL é contrato (preço não sabido), não zero', () => {
    const [i] = itensPedidoDoJson([{ ...ITEM, valor_unitario: null }], 'sales_orders p1');
    expect(i.valor_unitario).toBeNull();
  });

  it('NULL = sem itens; não-array e item fora da forma lançam com a origem', () => {
    expect(itensPedidoDoJson(null, 'sales_orders p1')).toEqual([]);
    expect(() => itensPedidoDoJson({}, 'sales_orders p1')).toThrow('sales_orders p1: items não é array');
    expect(() => itensPedidoDoJson([{ ...ITEM, omie_codigo_produto: '123' }], 'sales_orders p1')).toThrow(
      'sales_orders p1 item 0: "omie_codigo_produto" fora da forma (número)',
    );
    expect(() => itensPedidoDoJson([{ ...ITEM, codigo: 7 }], 'sales_orders p1')).toThrow('"codigo" fora da forma (texto)');
  });
});

describe('omiePayloadDoJson', () => {
  it('NULL = sem payload; objeto é preservado inteiro', () => {
    expect(omiePayloadDoJson(null, 'p1')).toBeNull();
    const p = { cabecalho: { codigo_parcela: '000', codigo_cliente: 9 }, det: [1] };
    expect(omiePayloadDoJson(p, 'p1')).toEqual(p);
  });

  it('payload ou cabecalho que não é objeto, e codigo_parcela não-texto, lançam', () => {
    expect(() => omiePayloadDoJson([], 'p1')).toThrow('p1.omie_payload: esperava objeto');
    expect(() => omiePayloadDoJson({ cabecalho: 'x' }, 'p1')).toThrow('p1.omie_payload.cabecalho: esperava objeto');
    expect(() => omiePayloadDoJson({ cabecalho: { codigo_parcela: 1 } }, 'p1')).toThrow('"codigo_parcela" fora da forma (texto)');
  });
});
