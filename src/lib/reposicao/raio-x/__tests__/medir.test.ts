import { describe, expect, it } from 'vitest';
import { medir } from '../medir';
import type { LinhaMedicao } from '../tipos';

const linha = (o: Partial<LinhaMedicao> = {}): LinhaMedicao => ({
  sku_codigo_omie: 1, destino: 'liquidar', decidido_em: null, foto_saldo: 10, foto_cmc: 5, foto_valor: 50,
  foto_categoria: 'mercadoria', credito_troca: null, saldo_atual: 10, qtd_vendida: 0, receita: 0,
  preco_medio_12m: 10, compras_apos: [], ...o,
});

describe('medir (oben)', () => {
  it('limita vendido ao saldo da foto', () => {
    const m = medir([linha({ saldo_atual: 4, qtd_vendida: 30, receita: 300 })], 'oben');
    expect(m.vendido).toBe(30);
    expect(m.liquidado).toBe(0);
    expect(m.saiu_sem_nf).toBeNull();
  });
  it('separa liquidado e margem sacrificada', () => {
    const m = medir([linha({ saldo_atual: 6, qtd_vendida: 4, receita: 20 })], 'oben');
    expect(m.liquidado).toBe(20);
    expect(m.vendido).toBe(0);
    expect(m.margem_sacrificada).toBe(4 * 10 - 20);
  });
  it('soma crédito de troca e não confunde com reclassificação', () => {
    const m = medir([
      linha({ destino: 'trocar', credito_troca: 30 }),
      linha({ sku_codigo_omie: 2, foto_categoria: 'nao_mercadoria', foto_valor: 100, saldo_atual: 0 }),
    ], 'oben');
    expect(m.trocado).toBe(30);
    expect(m.caixa_liberado).toBe(30);
    expect(m.reclassificado_nao_caixa).toBe(100);
  });
  it('acusa recompra após a decisão (compara instante)', () => {
    const m = medir([linha({ decidido_em: '2026-10-20T10:00:00Z', compras_apos: ['2026-10-19T00:00:00Z', '2026-11-02T00:00:00Z'] })], 'oben');
    expect(m.contradicoes).toEqual([{ sku_codigo_omie: 1, destino: 'liquidar', pedido_em: '2026-11-02T00:00:00Z' }]);
    const n = medir([linha({ decidido_em: '2026-10-20T16:00:00Z', compras_apos: ['2026-10-20T15:00:00-03:00'] })], 'oben');
    expect(n.contradicoes).toHaveLength(1);
  });
  it('destino sem contradição (venda_dirigida) não acusa', () => {
    const m = medir([linha({ destino: 'venda_dirigida', decidido_em: '2026-10-20T10:00:00Z', compras_apos: ['2026-11-02T00:00:00Z'] })], 'oben');
    expect(m.contradicoes).toEqual([]);
  });
  it('SKU ausente da medição atual não vira zero', () => {
    const m = medir([linha({ saldo_atual: null, qtd_vendida: null })], 'oben');
    expect(m.vendido).toBe(0);
    expect(m.parado).toBe(0);
    expect(m.sem_medicao_valor).toBe(50);
    expect(m.sem_medicao).toEqual([1]);
  });
  it('não conta como liberado o que foi recomprado', () => {
    const m = medir([linha({ saldo_atual: 10, qtd_vendida: 10, receita: 100 })], 'oben');
    expect(m.vendido).toBe(0);
    expect(m.caixa_liberado).toBe(0);
    expect(m.recomprado).toBe(50);
    expect(m.parado).toBe(50);
  });
  it('SKU ausente ainda conta o crédito de troca informado', () => {
    const m = medir([linha({ destino: 'trocar', credito_troca: 40, saldo_atual: null, qtd_vendida: null })], 'oben');
    expect(m.trocado).toBe(40);
    expect(m.parado).toBe(0);
  });
  it('uso_consumo na foto não entra em nada', () => {
    const m = medir([linha({ foto_categoria: 'uso_consumo', saldo_atual: 0, qtd_vendida: 10, receita: 100 })], 'oben');
    expect(m.vendido).toBe(0);
    expect(m.sem_medicao).toEqual([]);
  });
  it('compras_apos null (sem permissão) → recomprado null, sem contradições, compras_visiveis false', () => {
    const m = medir([
      linha({ saldo_atual: 10, qtd_vendida: 10, receita: 100, decidido_em: '2026-10-20T10:00:00Z', compras_apos: null }),
    ], 'oben');
    expect(m.recomprado).toBeNull();
    expect(m.contradicoes).toEqual([]);
    expect(m.compras_visiveis).toBe(false);
    expect(medir([linha()], 'oben').compras_visiveis).toBe(true);
  });
});

describe('medir — ausente ≠ zero e bordas', () => {
  it('foto_valor null em sem_medicao e reclassificado não soma 0: conta à parte', () => {
    const m = medir([
      linha({ sku_codigo_omie: 1, saldo_atual: null, qtd_vendida: null, foto_valor: null, foto_cmc: null }),
      linha({ sku_codigo_omie: 2, saldo_atual: null, qtd_vendida: null, foto_valor: 7 }),
      linha({ sku_codigo_omie: 3, foto_categoria: 'nao_mercadoria', foto_valor: null }),
      linha({ sku_codigo_omie: 4, foto_categoria: 'nao_mercadoria', foto_valor: 9 }),
    ], 'oben');
    expect(m.sem_medicao_valor).toBe(7);
    expect(m.sem_medicao_sem_custo_n).toBe(1);
    expect(m.reclassificado_nao_caixa).toBe(9);
    expect(m.reclassificado_sem_custo_n).toBe(1);
  });
  it('saldo_atual negativo não subtrai do parado; qtd_vendida negativa não vira venda', () => {
    const m = medir([linha({ saldo_atual: -4, qtd_vendida: -2, receita: -20 })], 'oben');
    expect(m.parado).toBe(0);
    expect(m.vendido).toBe(0);
    expect(m.recomprado).toBe(0);
  });
  it('Oben com receita null e qtd_vendida > 0 cai em vendido (sem preço do período)', () => {
    const m = medir([linha({ saldo_atual: 6, qtd_vendida: 4, receita: null })], 'oben');
    expect(m.vendido).toBe(20);
    expect(m.liquidado).toBe(0);
  });
});

describe('medir (colacor)', () => {
  it('vendido/liquidado null (ausente ≠ zero); saiu_sem_nf = (foto − atual) × cmc', () => {
    const m = medir([linha({ saldo_atual: 4, qtd_vendida: null, receita: null, preco_medio_12m: null, compras_apos: null })], 'colacor');
    expect(m.vendido).toBeNull();
    expect(m.liquidado).toBeNull();
    expect(m.margem_sacrificada).toBeNull();
    expect(m.saiu_sem_nf).toBe((10 - 4) * 5);
    expect(m.parado).toBe(4 * 5);
    expect(m.sem_medicao).toEqual([]);
  });
  it('estoque que subiu não abate a saída de outro SKU', () => {
    const m = medir([
      linha({ saldo_atual: 4, qtd_vendida: null, compras_apos: null }),
      linha({ sku_codigo_omie: 2, saldo_atual: 20, qtd_vendida: null, compras_apos: null }),
    ], 'colacor');
    expect(m.saiu_sem_nf).toBe(30);
  });
  it('linha sem foto ou sem saldo_atual vai a sem_medicao, sem número', () => {
    const m = medir([
      linha({ sku_codigo_omie: 1, saldo_atual: null, qtd_vendida: null, compras_apos: null }),
      linha({ sku_codigo_omie: 2, foto_saldo: null, foto_cmc: null, foto_valor: null, qtd_vendida: null, compras_apos: null }),
    ], 'colacor');
    expect(m.sem_medicao).toEqual([1, 2]);
    expect(m.saiu_sem_nf).toBe(0);
    expect(m.sem_medicao_valor).toBe(50);
    expect(m.sem_medicao_sem_custo_n).toBe(1);
  });
  it('crédito de troca ainda conta', () => {
    const m = medir([linha({ destino: 'trocar', credito_troca: 25, saldo_atual: 10, qtd_vendida: null, compras_apos: null })], 'colacor');
    expect(m.trocado).toBe(25);
    expect(m.caixa_liberado).toBe(25);
  });
});
