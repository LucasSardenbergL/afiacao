import { describe, it, expect } from 'vitest';
import {
  montarDadosAdicionaisNf,
  agruparItensPorAccount,
  validarEnvioResolvido,
  validarExtracao,
  type ItemResolvido,
  type ConfigConta,
} from './helpers';

const cfgOben: ConfigConta = {
  account: 'oben',
  codigo_cliente_omie: 8689689628,
  customer_user_id: '2ff308c9-d125-4e32-9033-6f46e88ef0b2',
  obs_venda: 'RECIBO DE ENTREGA...',
  dados_adicionais_nf: 'FORMA DE PGTO BOLETO',
  codigo_parcela: null,
};
const cfgColacorVazia: ConfigConta = {
  account: 'colacor',
  codigo_cliente_omie: null,
  customer_user_id: null,
  obs_venda: null,
  dados_adicionais_nf: null,
  codigo_parcela: null,
};

const itemOk: ItemResolvido = {
  id: 'i1', codigo_item_cliente: '3FLA0003M01', descricao_cliente: 'FLANELA',
  quantidade: 220, preco_final: 16.9, account: 'oben',
  omie_codigo_produto: 111, produto_codigo: 'FLA1', produto_descricao: 'FLANELA OBEN',
};

describe('montarDadosAdicionaisNf', () => {
  it('põe o nº do PC na primeira linha e a mensagem fixa depois', () => {
    expect(montarDadosAdicionaisNf('FORMA DE PGTO BOLETO', '213294'))
      .toBe('PEDIDO DE COMPRA Nº: 213294\n\nFORMA DE PGTO BOLETO');
  });
  it('sem mensagem fixa, só o nº do PC (não fabrica texto)', () => {
    expect(montarDadosAdicionaisNf(null, '213294')).toBe('PEDIDO DE COMPRA Nº: 213294');
  });
  it('lança com numeroPc vazio (backstop — nunca emitir NF com nº fabricado)', () => {
    expect(() => montarDadosAdicionaisNf('MSG', '')).toThrow();
  });
});

describe('agruparItensPorAccount', () => {
  it('separa itens por empresa', () => {
    const grupos = agruparItensPorAccount([
      itemOk,
      { ...itemOk, id: 'i2', account: 'colacor' },
      { ...itemOk, id: 'i3' },
    ]);
    expect(Object.keys(grupos).sort()).toEqual(['colacor', 'oben']);
    expect(grupos.oben).toHaveLength(2);
    expect(grupos.colacor).toHaveLength(1);
  });
});

describe('validarEnvioResolvido', () => {
  it('aprova envio 100% resolvido com config completa', () => {
    expect(validarEnvioResolvido('213294', [itemOk], { oben: cfgOben, colacor: cfgColacorVazia })).toEqual([]);
  });
  it('bloqueia pedido sem nº de PC (null e vazio)', () => {
    expect(validarEnvioResolvido(null, [itemOk], { oben: cfgOben, colacor: cfgColacorVazia }).join(' ')).toMatch(/n[úu]mero de pedido/i);
    expect(validarEnvioResolvido('  ', [itemOk], { oben: cfgOben, colacor: cfgColacorVazia })).not.toEqual([]);
  });
  it('bloqueia item sem mapeamento', () => {
    const p = validarEnvioResolvido(
      '213294',
      [{ ...itemOk, omie_codigo_produto: null, account: null }],
      { oben: cfgOben, colacor: cfgColacorVazia },
    );
    expect(p.join(' ')).toMatch(/sem mapeamento/i);
  });
  it('bloqueia preço NULL e preço 0 (ausente ≠ zero)', () => {
    expect(validarEnvioResolvido('213294', [{ ...itemOk, preco_final: null }], { oben: cfgOben, colacor: cfgColacorVazia })).not.toEqual([]);
    expect(validarEnvioResolvido('213294', [{ ...itemOk, preco_final: 0 }], { oben: cfgOben, colacor: cfgColacorVazia })).not.toEqual([]);
  });
  it('bloqueia preço NaN e Infinity (Number.isFinite morde)', () => {
    expect(validarEnvioResolvido('213294', [{ ...itemOk, preco_final: NaN }], { oben: cfgOben, colacor: cfgColacorVazia })).not.toEqual([]);
    expect(validarEnvioResolvido('213294', [{ ...itemOk, preco_final: Infinity }], { oben: cfgOben, colacor: cfgColacorVazia })).not.toEqual([]);
  });
  it('bloqueia quantidade inválida', () => {
    expect(validarEnvioResolvido('213294', [{ ...itemOk, quantidade: 0 }], { oben: cfgOben, colacor: cfgColacorVazia })).not.toEqual([]);
  });
  it('aceita quantidade fracionária (0.5 MT — o PDF real tem metragem)', () => {
    expect(validarEnvioResolvido('213294', [{ ...itemOk, quantidade: 0.5 }], { oben: cfgOben, colacor: cfgColacorVazia })).toEqual([]);
  });
  it('bloqueia account sem config (cliente não cadastrado na Colacor)', () => {
    const p = validarEnvioResolvido(
      '213294',
      [{ ...itemOk, account: 'colacor' }],
      { oben: cfgOben, colacor: cfgColacorVazia },
    );
    expect(p.join(' ')).toMatch(/colacor/i);
  });
});

describe('validarExtracao', () => {
  it('aceita extração válida e normaliza itens', () => {
    const r = validarExtracao({
      numero_pedido_compra: '213294', data_emissao: '2026-05-20', versao: '2',
      itens: [{
        codigo_item_cliente: '3FLA0003M01', num_ordem_cliente: '50072329',
        descricao_cliente: 'FLANELA MICROFIBRA', quantidade: 220, unidade: 'UN',
        preco_unitario: 16.9, data_entrega: '2026-07-20', cod_forn: '644',
      }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dados.itens[0].quantidade).toBe(220);
  });
  it('rejeita sem nº do PC ou sem itens', () => {
    expect(validarExtracao({ numero_pedido_compra: null, data_emissao: null, versao: null, itens: [] }).ok).toBe(false);
  });
  it('degrada campo ruim para null em vez de inventar (data inválida, preço não-numérico)', () => {
    const r = validarExtracao({
      numero_pedido_compra: '213294', data_emissao: 'banana', versao: null,
      itens: [{
        codigo_item_cliente: 'X', num_ordem_cliente: null, descricao_cliente: 'Y',
        quantidade: 1, unidade: null, preco_unitario: 'errado', data_entrega: '20/07/2026', cod_forn: null,
      }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dados.data_emissao).toBeNull();
      expect(r.dados.itens[0].preco_unitario).toBeNull();
      expect(r.dados.itens[0].data_entrega).toBeNull(); // só aceita YYYY-MM-DD
    }
  });
  it('rejeita item sem codigo_item_cliente ou quantidade inválida', () => {
    const r = validarExtracao({
      numero_pedido_compra: '213294', data_emissao: null, versao: null,
      itens: [{ codigo_item_cliente: null, num_ordem_cliente: null, descricao_cliente: 'Y', quantidade: 0, unidade: null, preco_unitario: null, data_entrega: null, cod_forn: null }],
    });
    expect(r.ok).toBe(false);
  });
  it('aceita quantidade fracionária na extração (1,000 MT → 1; 0.5 → 0.5)', () => {
    const r = validarExtracao({
      numero_pedido_compra: '213294', data_emissao: null, versao: null,
      itens: [{ codigo_item_cliente: 'X', num_ordem_cliente: null, descricao_cliente: 'Y', quantidade: 0.5, unidade: 'MT', preco_unitario: null, data_entrega: null, cod_forn: null }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dados.itens[0].quantidade).toBe(0.5);
  });
});
