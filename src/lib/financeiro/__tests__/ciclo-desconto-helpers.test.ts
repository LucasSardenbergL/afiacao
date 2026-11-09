import { describe, expect, it } from 'vitest';
import { custoAnualDoDesconto, elegibilidadeDesconto, normalizarCustoCapital } from '../ciclo-desconto-helpers';
import type { ResumoCliente } from '../ciclo-cliente-helpers';

const base: ResumoCliente = {
  company: 'oben', omieCodigoCliente: 1, nomeCliente: 'X', nParcelas: 10, nDocumentos: 8, valorPago: 1000, valorPagoSemBaixa: 0,
  prazoConcedidoPond: 30, prazoRealPond: 32, atrasoPond: 2, atrasoP50: 1, atrasoP80: 3, atrasoP80Valor: 3, atrasoMaxObservado: 10,
  excessoCarenciaPond: 0, pctValorAtrasado: 0.3, ultimaBaixa: '2026-10-01', nVencidas: 0, saldoVencido: 0, saldoVencido90: 0,
  diasVencidoMax: null, volumeEmitido12m: 12000, primeiraEmissao: '2025-01-01', nStatusAmbiguo: 0,
};

describe('normalizarCustoCapital — ausente ≠ zero, inválido não é custo', () => {
  it('fração válida passa; string numérica do PostgREST passa', () => {
    expect(normalizarCustoCapital({ company: 'oben', custo_capital_mensal: 0.025, custo_capital_fonte: 'founder', custo_capital_em: '2026-10-31T00:00:00Z' }))
      .toEqual({ company: 'oben', custoMensal: 0.025, fonte: 'founder', em: '2026-10-31T00:00:00Z' });
    expect(normalizarCustoCapital({ company: 'oben', custo_capital_mensal: '0.025' })?.custoMensal).toBe(0.025);
  });
  it('NULL, 0, acima do teto, NaN e sem company → custo null / linha null', () => {
    expect(normalizarCustoCapital({ company: 'colacor', custo_capital_mensal: null })?.custoMensal).toBeNull();
    expect(normalizarCustoCapital({ company: 'colacor', custo_capital_mensal: 0 })?.custoMensal).toBeNull();
    expect(normalizarCustoCapital({ company: 'colacor', custo_capital_mensal: 0.5 })?.custoMensal).toBeNull();
    expect(normalizarCustoCapital({ company: 'colacor', custo_capital_mensal: 'NaN' })?.custoMensal).toBeNull();
    expect(normalizarCustoCapital({ custo_capital_mensal: 0.02 })).toBeNull();
  });
});

describe('custoAnualDoDesconto — 1% por 7 dias ≈ 68,9% a.a. (fórmula de quem concede)', () => {
  it('1% / 7 d', () => {
    const a = custoAnualDoDesconto(0.01, 7)!;
    expect(a).toBeGreaterThan(0.688);
    expect(a).toBeLessThan(0.690);
  });
  it('entradas inválidas → null', () => {
    expect(custoAnualDoDesconto(0, 7)).toBeNull();
    expect(custoAnualDoDesconto(1, 7)).toBeNull();
    expect(custoAnualDoDesconto(0.01, 0)).toBeNull();
    expect(custoAnualDoDesconto(Number.NaN, 7)).toBeNull();
  });
});

describe('elegibilidadeDesconto — só onde antecipa caixa de fato', () => {
  it('quem já antecipa nas DUAS leituras (p80 ≤ −3) é inelegível', () => {
    expect(elegibilidadeDesconto({ ...base, atrasoP80: -5, atrasoP80Valor: -4 })).toEqual({ elegivel: false, motivo: 'ja_antecipa' });
  });
  it('folga só numa leitura (misto) → elegível (atrasa em parte)', () => {
    expect(elegibilidadeDesconto({ ...base, atrasoP80: -5, atrasoP80Valor: 2 })).toEqual({ elegivel: true, motivo: 'atrasa' });
  });
  it('pontual (p80 entre −3 e 0) → elegível, motivo pontual', () => {
    expect(elegibilidadeDesconto({ ...base, atrasoP80: 0, atrasoP80Valor: -1 })).toEqual({ elegivel: true, motivo: 'pontual' });
  });
  it('atraso leve/crônico → elegível', () => {
    expect(elegibilidadeDesconto({ ...base, atrasoP80: 12, atrasoP80Valor: 15 })).toEqual({ elegivel: true, motivo: 'atrasa' });
  });
  it('sem histórico (p80 null) e sem vencido → sem_historico, nunca "já paga antes"', () => {
    expect(elegibilidadeDesconto({ ...base, atrasoP80: null, atrasoP80Valor: null })).toEqual({ elegivel: false, motivo: 'sem_historico' });
  });
  it('vencido em aberto torna elegível mesmo sem histórico', () => {
    expect(elegibilidadeDesconto({ ...base, atrasoP80: null, atrasoP80Valor: null, nVencidas: 2, saldoVencido: 500 })).toEqual({ elegivel: true, motivo: 'vencido' });
  });
});
