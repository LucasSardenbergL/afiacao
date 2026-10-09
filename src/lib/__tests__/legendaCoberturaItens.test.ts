import { describe, it, expect } from 'vitest';
import { legendaCoberturaItens } from '../format';

describe('legendaCoberturaItens', () => {
  it('parcial: "3 de 40 linhas c/ custo"', () => {
    expect(legendaCoberturaItens({ itensComCusto: 3, itensSemCusto: 37 })).toBe('3 de 40 linhas c/ custo');
  });

  it('total: todas as linhas com custo', () => {
    expect(legendaCoberturaItens({ itensComCusto: 40, itensSemCusto: 0 })).toBe('40 de 40 linhas c/ custo');
  });

  it('0 é VEREDITO, não ausência: "nenhuma de 40 linhas c/ custo"', () => {
    expect(legendaCoberturaItens({ itensComCusto: 0, itensSemCusto: 40 })).toBe('nenhuma de 40 linhas c/ custo');
  });

  it('singular quando o total é 1', () => {
    expect(legendaCoberturaItens({ itensComCusto: 1, itensSemCusto: 0 })).toBe('1 de 1 linha c/ custo');
    expect(legendaCoberturaItens({ itensComCusto: 0, itensSemCusto: 1 })).toBe('nenhuma de 1 linha c/ custo');
  });

  it('milhar em pt-BR', () => {
    expect(legendaCoberturaItens({ itensComCusto: 1200, itensSemCusto: 300 })).toBe('1.200 de 1.500 linhas c/ custo');
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
