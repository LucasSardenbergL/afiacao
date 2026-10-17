import { describe, expect, it } from 'vitest';
import { categorizar, classificar, cobertura, sugerirDestino, TOP_N } from '../classificar';
import { fato, HOJE } from './fixtures';

describe('categorizar', () => {
  it('Imobilizado sempre é nao_mercadoria', () => {
    expect(categorizar(fato({ familia: 'Imobilizado', q12: 5 })).categoria).toBe('nao_mercadoria');
  });
  it('CARTELA/MOSTRUARIO sem venda é nao_mercadoria; com venda é mercadoria', () => {
    expect(categorizar(fato({ descricao: 'CAIXA MOSTRUARIO' })).categoria).toBe('nao_mercadoria');
    expect(categorizar(fato({ descricao: 'CARTELA DE 720 CORES', q12: 3 })).categoria).toBe('mercadoria');
  });
  it('concentrados e granel da fase A viram uso_consumo, mantendo o motivo', () => {
    const atl = categorizar(fato({ familia: 'Concentrados LC', descricao: 'ATL233-POLIESTER' }));
    expect(atl.categoria).toBe('uso_consumo');
    expect(atl.motivo).toContain('ATL/ATP');
    expect(categorizar(fato({ familia: 'Concentrados LC', descricao: 'VERNIZ PU 5:1' })).categoria).toBe('mercadoria');
    const mix = categorizar(fato({ familia: 'Concentrados MixMachine' }));
    expect(mix.categoria).toBe('uso_consumo');
    expect(mix.motivo).toBe('concentrado da MixMachine');
    const g1 = categorizar(fato({ descricao: 'COLA BRANCA PVA EXTRA 1000KG' }));
    expect(g1.categoria).toBe('uso_consumo');
    expect(g1.motivo).toContain('granel');
    expect(categorizar(fato({ descricao: 'COLA AMARELA 1000 KG' })).categoria).toBe('uso_consumo');
  });
  it("tipo '08' → nao_mercadoria com 'tipo 08' no motivo", () => {
    const r = categorizar(fato({ tipo_produto: '08', q12: 3 }));
    expect(r.categoria).toBe('nao_mercadoria');
    expect(r.motivo).toContain('tipo do item 08');
  });
  it.each(['07', '01', '03'])("tipo '%s' → uso_consumo com o código no motivo", (t) => {
    const r = categorizar(fato({ tipo_produto: t }));
    expect(r.categoria).toBe('uso_consumo');
    expect(r.motivo).toContain(t);
  });
  it('família Material de Uso e Consumo → uso_consumo', () => {
    expect(categorizar(fato({ familia: 'Material de Uso e Consumo' })).categoria).toBe('uso_consumo');
  });
  it("'04' e '00' → mercadoria", () => {
    expect(categorizar(fato({ tipo_produto: '04' })).categoria).toBe('mercadoria');
    expect(categorizar(fato({ tipo_produto: '00' })).categoria).toBe('mercadoria');
  });
  it('manual vence o cadastro, nos dois sentidos', () => {
    expect(categorizar(fato({ tipo_produto: '07' }), { categoria: 'mercadoria', motivo: 'revenda de fato' }))
      .toEqual({ categoria: 'mercadoria', motivo: 'revenda de fato' });
    expect(categorizar(fato({ tipo_produto: '00' }), { categoria: 'uso_consumo', motivo: 'consumido na oficina' }))
      .toEqual({ categoria: 'uso_consumo', motivo: 'consumido na oficina' });
  });
  it('sem cadastro (tipo, família e descrição nulos) → mercadoria, "sem cadastro no Omie"', () => {
    expect(categorizar(fato({ tipo_produto: null, familia: null, descricao: null })))
      .toEqual({ categoria: 'mercadoria', motivo: 'sem cadastro no Omie' });
  });
});

describe('cobertura', () => {
  it('null sem venda ou sem histórico; dias quando vende', () => {
    expect(cobertura(fato())).toBeNull();
    expect(cobertura(fato({ q12: null }))).toBeNull();
    expect(cobertura(fato({ saldo: 365, q12: 365 }))).toBe(365);
  });
});

describe('sugerirDestino', () => {
  it('ordem das regras', () => {
    expect(sugerirDestino(fato({ cadastro_em: '2026-09-01' }), HOJE).destino).toBe('novo_aguarde');
    expect(sugerirDestino(fato({ ult_entrada: '2026-10-02' }), HOJE).destino).toBe('novo_aguarde');
    expect(sugerirDestino(fato({ unidades_venda: ['UN', 'GL'] }), HOJE).destino).toBe('revisar');
    expect(sugerirDestino(fato({ fornecedor: 'RENNER SAYERLACK S/A' }), HOJE).destino).toBe('trocar');
    expect(sugerirDestino(fato({ fornecedor: 'marca: SAYERLACK' }), HOJE).destino).toBe('trocar');
    expect(sugerirDestino(fato({ q12: 1, saldo: 10 }), HOJE).destino).toBe('venda_dirigida'); // 3650 d
    expect(sugerirDestino(fato({ q12: 10, saldo: 7 }), HOJE).destino).toBe('manter_suspender_recompra'); // 255,5 d
    expect(sugerirDestino(fato({ fornecedor: 'ACRE CAXIAS' }), HOJE).destino).toBe('liquidar');
    expect(sugerirDestino(fato({ q12: 100, saldo: 10 }), HOJE).destino).toBe('revisar'); // 36,5 d
  });
  it('q12 null → sem_historico, nunca liquidar', () => {
    const r = sugerirDestino(fato({ q12: null, fornecedor: 'ACRE CAXIAS' }), HOJE);
    expect(r.destino).toBe('sem_historico');
    expect(r.motivo).toBe('sem histórico de venda (NF) — decida manualmente');
  });
  it('unidades_venda null (Colacor) não dispara revisar por unidade', () => {
    expect(sugerirDestino(fato({ q12: null, unidades_venda: null }), HOJE).destino).toBe('sem_historico');
  });
});

describe('classificar', () => {
  const sem = new Map();
  it('valor, ordenação desc e top só em mercadoria parada', () => {
    const r = classificar([
      fato({ sku_codigo_omie: 1, saldo: 1, cmc: 100 }),
      fato({ sku_codigo_omie: 2, saldo: 1, cmc: 999, familia: 'Imobilizado' }),
      fato({ sku_codigo_omie: 3, saldo: 1, cmc: 50 }),
    ], sem, 'oben', HOJE);
    const by = Object.fromEntries(r.map((i) => [i.sku_codigo_omie, i]));
    expect(by[1].valor).toBe(100);
    expect(by[2].top).toBe(false);
    expect(by[1].top).toBe(true);
    expect(r[0].sku_codigo_omie).toBe(2);
    expect(TOP_N).toBe(61);
  });
  it('cmc null → valor null, nulos ao fim, fora do Top', () => {
    const r = classificar([
      fato({ sku_codigo_omie: 1, cmc: null }),
      fato({ sku_codigo_omie: 2, cmc: 1 }),
    ], sem, 'oben', HOJE);
    expect(r.map((i) => i.sku_codigo_omie)).toEqual([2, 1]);
    expect(r[1].valor).toBeNull();
    expect(r[1].top).toBe(false);
    expect(r[0].top).toBe(true);
  });
  it('Top = 61 maiores', () => {
    const fatos = Array.from({ length: 70 }, (_, k) => fato({ sku_codigo_omie: k + 1, cmc: k + 1 }));
    const r = classificar(fatos, sem, 'oben', HOJE);
    expect(r.filter((i) => i.top)).toHaveLength(61);
    expect(r.find((i) => i.sku_codigo_omie === 70)?.top).toBe(true);
    expect(r.find((i) => i.sku_codigo_omie === 9)?.top).toBe(false);
  });
  it('Oben: parado = fora do motor, q12 0 ou cobertura > 180', () => {
    const r = classificar([
      fato({ sku_codigo_omie: 1, no_motor: true, q12: 100, saldo: 10 }), // 36,5 d, no motor → não parado
      fato({ sku_codigo_omie: 2, no_motor: false, q12: 100, saldo: 10 }),
      fato({ sku_codigo_omie: 3, no_motor: true, q12: 0 }),
      fato({ sku_codigo_omie: 4, no_motor: true, q12: 10, saldo: 7 }), // 255 d
    ], sem, 'oben', HOJE);
    const p = Object.fromEntries(r.map((i) => [i.sku_codigo_omie, i.parado]));
    expect(p).toEqual({ 1: false, 2: true, 3: true, 4: true });
    expect(r.find((i) => i.sku_codigo_omie === 1)?.destino_sugerido).toBeNull();
  });
  it('Colacor: toda mercadoria é parada; não mercadoria não', () => {
    const r = classificar([
      fato({ sku_codigo_omie: 1, q12: null, no_motor: true }),
      fato({ sku_codigo_omie: 2, q12: null, familia: 'Imobilizado' }),
    ], sem, 'colacor', HOJE);
    expect(r.find((i) => i.sku_codigo_omie === 1)?.parado).toBe(true);
    expect(r.find((i) => i.sku_codigo_omie === 1)?.destino_sugerido).toBe('sem_historico');
    expect(r.find((i) => i.sku_codigo_omie === 2)?.parado).toBe(false);
  });
  it('classificação manual entra pelo mapa', () => {
    const r = classificar([fato({ sku_codigo_omie: 7 })], new Map([[7, { categoria: 'uso_consumo' as const, motivo: 'm' }]]), 'oben', HOJE);
    expect(r[0].categoria).toBe('uso_consumo');
    expect(r[0].parado).toBe(false);
  });
});
