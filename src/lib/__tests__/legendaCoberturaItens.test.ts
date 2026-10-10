import { describe, it, expect } from 'vitest';
import { legendaCoberturaItens, legendaMargemSemCompraNaJanela } from '../format';

describe('legendaCoberturaItens', () => {
  it('parcial: "3 de 40 linhas c/ custo"', () => {
    expect(legendaCoberturaItens({ itensComCusto: 3, itensSemCusto: 37 })).toBe('3 de 40 linhas c/ custo (últimos 12 meses)');
  });

  it('total: todas as linhas com custo', () => {
    expect(legendaCoberturaItens({ itensComCusto: 40, itensSemCusto: 0 })).toBe('40 de 40 linhas c/ custo (últimos 12 meses)');
  });

  it('0 é VEREDITO, não ausência: "nenhuma de 40 linhas c/ custo"', () => {
    expect(legendaCoberturaItens({ itensComCusto: 0, itensSemCusto: 40 })).toBe('nenhuma de 40 linhas c/ custo (últimos 12 meses)');
  });

  it('singular quando o total é 1', () => {
    expect(legendaCoberturaItens({ itensComCusto: 1, itensSemCusto: 0 })).toBe('1 de 1 linha c/ custo (últimos 12 meses)');
    expect(legendaCoberturaItens({ itensComCusto: 0, itensSemCusto: 1 })).toBe('nenhuma de 1 linha c/ custo (últimos 12 meses)');
  });

  it('milhar em pt-BR', () => {
    expect(legendaCoberturaItens({ itensComCusto: 1200, itensSemCusto: 300 })).toBe('1.200 de 1.500 linhas c/ custo (últimos 12 meses)');
  });

  it('ausente≠zero: cobertura não computada (qualquer lado null) → null, nunca "0 de 0"', () => {
    expect(legendaCoberturaItens({ itensComCusto: null, itensSemCusto: null })).toBeNull();
    expect(legendaCoberturaItens({ itensComCusto: 3, itensSemCusto: null })).toBeNull();
    expect(legendaCoberturaItens({ itensComCusto: null, itensSemCusto: 3 })).toBeNull();
  });

  it('total 0 (contrato violado: linha na RPC sem item) → null, não "nenhuma de 0"', () => {
    expect(legendaCoberturaItens({ itensComCusto: 0, itensSemCusto: 0 })).toBeNull();
  });
});

describe('legendaMargemSemCompraNaJanela', () => {
  it('365+ dias sem compra → afirma o motivo da margem ausente', () => {
    // 365 dias civis já pode estar fora da janela SQL (corte por instante) — achado Codex 2026-10-09.
    expect(legendaMargemSemCompraNaJanela(365)).toBe('sem compra nos últimos 12 meses');
    expect(legendaMargemSemCompraNaJanela(366)).toBe('sem compra nos últimos 12 meses');
    // 999 é o sentinela do calculate-scores para "sem compra registrada" — também fora da janela.
    expect(legendaMargemSemCompraNaJanela(999)).toBe('sem compra nos últimos 12 meses');
  });

  it('comprou dentro da janela → null (o motivo da ausência é outro, não a janela)', () => {
    expect(legendaMargemSemCompraNaJanela(364)).toBeNull();
    expect(legendaMargemSemCompraNaJanela(0)).toBeNull();
  });

  it('dias ausente/não-finito → null, nunca afirma "sem compra" sem dado', () => {
    expect(legendaMargemSemCompraNaJanela(null)).toBeNull();
    expect(legendaMargemSemCompraNaJanela(undefined)).toBeNull();
    expect(legendaMargemSemCompraNaJanela(Number.NaN)).toBeNull();
  });
});
