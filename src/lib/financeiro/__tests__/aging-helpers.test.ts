import { describe, it, expect } from 'vitest';
import {
  faixaAging, daysBetween, addDays,
  mediaPonderada, mediana,
  calibrarCurvas, CURVA_DEFAULT,
  dataRecebimentoEsperada, aplicarCenarioCurva,
  inadimplenciaPonderada, prazoMedioPonderado,
} from '../aging-helpers';

describe('faixaAging', () => {
  it('não vencido ou vence hoje → a_vencer', () => {
    expect(faixaAging(0)).toBe('a_vencer');
    expect(faixaAging(-5)).toBe('a_vencer');
  });
  it('limites das faixas', () => {
    expect(faixaAging(1)).toBe('1-30');
    expect(faixaAging(30)).toBe('1-30');
    expect(faixaAging(31)).toBe('31-60');
    expect(faixaAging(60)).toBe('31-60');
    expect(faixaAging(61)).toBe('61-90');
    expect(faixaAging(90)).toBe('61-90');
    expect(faixaAging(91)).toBe('+90');
    expect(faixaAging(400)).toBe('+90');
  });
});

describe('daysBetween / addDays', () => {
  it('daysBetween em dias inteiros', () => {
    expect(daysBetween('2026-05-19', '2026-05-09')).toBe(10);
  });
  it('addDays soma dias (UTC)', () => {
    expect(addDays('2026-05-19', 7)).toBe('2026-05-26');
  });
});

describe('mediaPonderada', () => {
  it('pondera por peso (R$)', () => {
    expect(mediaPonderada([{ valor: 70, peso: 100000 }, { valor: 5, peso: 1000 }])).toBeCloseTo(69.36, 1);
  });
  it('peso total 0 → 0', () => {
    expect(mediaPonderada([{ valor: 10, peso: 0 }])).toBe(0);
  });
});

describe('mediana', () => {
  it('ímpar', () => { expect(mediana([5, 1, 3])).toBe(3); });
  it('par = média dos centrais', () => { expect(mediana([1, 2, 3, 4])).toBe(2.5); });
  it('vazio → 0', () => { expect(mediana([])).toBe(0); });
});

const hoje = '2026-05-19';

describe('calibrarCurvas (por exposição)', () => {
  it('aberto não-pago na faixa puxa a taxa pra baixo (sem viés)', () => {
    const titulos = [
      { valor_documento: 100000, valor_recebido: 100000, saldo: 0, data_vencimento: '2026-03-20', data_recebimento: '2026-04-24', status_titulo: 'RECEBIDO' }, // 35d → 31-60
      { valor_documento: 100000, valor_recebido: 0, saldo: 100000, data_vencimento: '2026-04-04', data_recebimento: null, status_titulo: 'VENCIDO' }, // 45d hoje → 31-60
    ];
    // minTitulos/minVolume baixos pra exercitar o cálculo (o gate de confiança é testado à parte)
    const curvas = calibrarCurvas(titulos, hoje, 1, 1);
    expect(curvas['31-60'].taxa_recebimento).toBeCloseTo(0.5, 5);
    expect(curvas['31-60'].exposicao).toBe(200000);
    expect(curvas['31-60'].pago).toBe(100000);
    expect(curvas['31-60'].aberto).toBe(100000);
  });
  it('amostra fraca (poucos títulos) → confiança baixa + default', () => {
    const titulos = [
      { valor_documento: 1000, valor_recebido: 1000, saldo: 0, data_vencimento: '2026-05-10', data_recebimento: '2026-05-14', status_titulo: 'RECEBIDO' },
    ];
    const curvas = calibrarCurvas(titulos, hoje, 20, 50000);
    expect(curvas['1-30'].confianca).toBe('baixa');
    expect(curvas['1-30'].taxa_recebimento).toBe(CURVA_DEFAULT['1-30'].taxa_recebimento);
  });
});

describe('dataRecebimentoEsperada', () => {
  it('a_vencer: vencimento + lag', () => {
    expect(dataRecebimentoEsperada({ data_vencimento: '2026-06-01', hoje: '2026-05-19', faixa: 'a_vencer', lag_dias_faixa: 5 })).toBe('2026-06-06');
  });
  it('vencido: hoje + lag restante (lag - atraso atual)', () => {
    expect(dataRecebimentoEsperada({ data_vencimento: '2026-05-09', hoje: '2026-05-19', faixa: '1-30', lag_dias_faixa: 20 })).toBe('2026-05-29');
  });
  it('vencido além do lag esperado: usa residual default (não cai hoje)', () => {
    expect(dataRecebimentoEsperada({ data_vencimento: '2025-11-01', hoje: '2026-05-19', faixa: '+90', lag_dias_faixa: 150, lag_residual_default: 15 })).toBe('2026-06-03');
  });
});

describe('aplicarCenarioCurva (clamps)', () => {
  const base = { taxa_recebimento: 0.8, lag_dias: 70, lag_mediana: 60, exposicao: 0, pago: 0, aberto: 0, confianca: 'alta' as const };
  it('otimista: taxa sobe (perda cai), lag cai', () => {
    const r = aplicarCenarioCurva(base, '61-90', { recebimento_no_prazo_pct_delta: 10, inadimplencia_pct_delta: -50 });
    expect(r.taxa_recebimento).toBeCloseTo(0.9, 5);
    expect(r.lag_dias).toBeCloseTo(63, 5);
  });
  it('pessimista: taxa cai, lag sobe mas respeita LAG_MAX', () => {
    const r = aplicarCenarioCurva({ ...base, lag_dias: 115 }, '61-90', { recebimento_no_prazo_pct_delta: -15, inadimplencia_pct_delta: 50 });
    expect(r.taxa_recebimento).toBeCloseTo(0.7, 5);
    expect(r.lag_dias).toBe(120);
  });
  it('taxa nunca passa de 1 nem fica negativa', () => {
    const r = aplicarCenarioCurva({ ...base, taxa_recebimento: 0.95 }, 'a_vencer', { recebimento_no_prazo_pct_delta: 0, inadimplencia_pct_delta: -200 });
    expect(r.taxa_recebimento).toBe(1);
  });
});

describe('inadimplenciaPonderada', () => {
  it('média ponderada por R$ de (1 - taxa) sobre CR aberto', () => {
    const curvas = {
      'a_vencer': { taxa_recebimento: 1.0 }, '1-30': { taxa_recebimento: 0.9 },
      '31-60': { taxa_recebimento: 0.8 }, '61-90': { taxa_recebimento: 0.7 }, '+90': { taxa_recebimento: 0.5 },
    } as Record<'a_vencer'|'1-30'|'31-60'|'61-90'|'+90', { taxa_recebimento: number }>;
    const crs = [
      { saldo: 100000, faixa: 'a_vencer' as const },
      { saldo: 100000, faixa: '+90' as const },
    ];
    expect(inadimplenciaPonderada(crs, curvas)).toBeCloseTo(25, 5);
  });
});

describe('prazoMedioPonderado', () => {
  it('pondera por valor (não por contagem)', () => {
    expect(prazoMedioPonderado([
      { dias: 70, valor: 100000 }, { dias: 5, valor: 1000 },
    ])).toBeCloseTo(69.36, 1);
  });
});
