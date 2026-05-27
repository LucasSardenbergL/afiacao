import { describe, it, expect } from 'vitest';
import { mesesFechados, razaoYTD, fatorTendenciaYTD, derivarLinhas } from '../orcamento-forecast-helpers';

describe('mesesFechados', () => {
  it('ano corrente exclui o mês corrente e futuros', () => { expect(mesesFechados(2026, new Date('2026-05-15'))).toEqual([1,2,3,4]); });
  it('ano passado = 12', () => { expect(mesesFechados(2025, new Date('2026-05-15'))).toHaveLength(12); });
  it('ano futuro = []', () => { expect(mesesFechados(2027, new Date('2026-05-15'))).toEqual([]); });
});
describe('razaoYTD', () => {
  it('Σnum/Σden', () => { expect(razaoYTD([10,20],[100,100])).toBeCloseTo(0.15,6); });
  it('denominador <=0 → null', () => { expect(razaoYTD([10],[0])).toBeNull(); expect(razaoYTD([10],[-5])).toBeNull(); });
  it('vazio → null', () => { expect(razaoYTD([],[])).toBeNull(); });
});
describe('fatorTendenciaYTD', () => {
  it('Σreceita atual / ano-1 (mesmos meses), cap [0.5,2.0]', () => {
    expect(fatorTendenciaYTD([{mes:1,receita_bruta:110},{mes:2,receita_bruta:130}],[{mes:1,receita_bruta:100},{mes:2,receita_bruta:100}],[1,2])).toBeCloseTo(1.2,6);
  });
  it('cap superior 2.0', () => { expect(fatorTendenciaYTD([{mes:1,receita_bruta:500}],[{mes:1,receita_bruta:100}],[1])).toBe(2.0); });
  it('base ano-1 <=0 → null', () => { expect(fatorTendenciaYTD([{mes:1,receita_bruta:100}],[],[1])).toBeNull(); });
});
describe('derivarLinhas', () => {
  it('fórmulas e sinais (FinDRE)', () => {
    const d = derivarLinhas({ receita_bruta:1000, deducoes:100, cmv:400, despesas_operacionais:50, despesas_administrativas:30, despesas_comerciais:20, receitas_financeiras:10, despesas_financeiras:5, outras_receitas:0, outras_despesas:0, impostos:40 });
    expect(d.receita_liquida).toBe(900);
    expect(d.lucro_bruto).toBe(500);
    expect(d.resultado_operacional).toBe(400);
    expect(d.resultado_antes_impostos).toBe(405);
    expect(d.resultado_liquido).toBe(365);
  });
  it('campos omitidos = 0, sem NaN', () => {
    const d = derivarLinhas({ receita_bruta:500 });
    expect(d.receita_liquida).toBe(500); expect(Number.isNaN(d.resultado_liquido)).toBe(false); expect(d.resultado_liquido).toBe(500);
  });
});
