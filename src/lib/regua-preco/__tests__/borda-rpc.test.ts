import { describe, it, expect } from 'vitest';
import { fetchDataReguaDoJson, fetchDatas360DoJson } from '../borda-rpc';

const PACOTE = {
  abaixo_piso: true,
  piso_disponivel: true,
  cmc_confiavel: true,
  prazo_aplicado: false,
  piso_mc: null,
  piso_gap_pct: null,
  precos_cliente: [90, 95],
  comparaveis: [{ preco: 88, c: 1 }],
};

describe('fetchDataReguaDoJson', () => {
  it('lê o pacote e mantém NULL explícito (número mascarado ≠ 0)', () => {
    const d = fetchDataReguaDoJson(PACOTE);
    expect(d.piso_mc).toBeNull();
    expect(d.piso_gap_pct).toBeNull();
    expect(d.comparaveis).toEqual([{ preco: 88, c: 1 }]);
  });

  it('chave ausente ou tipo trocado lança', () => {
    const { abaixo_piso: _, ...semAbaixo } = PACOTE;
    expect(() => fetchDataReguaDoJson(semAbaixo)).toThrow('get_regua_preco: "abaixo_piso" fora da forma (booleano)');
    expect(() => fetchDataReguaDoJson({ ...PACOTE, piso_mc: '10' })).toThrow('"piso_mc" fora da forma (número ou null)');
    expect(() => fetchDataReguaDoJson({ ...PACOTE, precos_cliente: [1, null] })).toThrow('"precos_cliente" com item não numérico');
    expect(() => fetchDataReguaDoJson(null)).toThrow('get_regua_preco: esperava objeto');
  });
});

describe('fetchDatas360DoJson', () => {
  it('descritor omitido por hide_reason vira null; sem pacote, campos da régua ficam ausentes', () => {
    const [semProduto, completo] = fetchDatas360DoJson([
      { omie_codigo: 7003, hide_reason: 'sem_produto' },
      { omie_codigo: 7001, product_id: 'p1', preco_atual: 90, preco_atual_at: '2026-06-06', qty_ref: 2, qty_ref_source: 'ultima_venda', hide_reason: null, ...PACOTE },
    ]);
    expect(semProduto).toEqual({
      omie_codigo: 7003, product_id: null, preco_atual: null, preco_atual_at: null,
      qty_ref: null, qty_ref_source: null, hide_reason: 'sem_produto',
    });
    expect('abaixo_piso' in semProduto).toBe(false);
    expect(completo.abaixo_piso).toBe(true);
    expect(completo.qty_ref).toBe(2);
  });

  it('retorno que não é array lança', () => {
    expect(() => fetchDatas360DoJson({})).toThrow('get_regua_preco_customer360: retorno não é array');
  });
});
