import { describe, it, expect } from 'vitest';
import { fmt, fmtDur, healthColors, metricLabels, statusColors } from '../helpers';

describe('fmt', () => {
  it('formata como moeda BRL', () => {
    const s = fmt(1234.5);
    expect(s).toContain('R$');
    expect(s).toContain('1.234,50');
  });
});

describe('fmtDur', () => {
  it('segundos puros quando < 60', () => {
    expect(fmtDur(0)).toBe('0s');
    expect(fmtDur(45)).toBe('45s');
    expect(fmtDur(59.4)).toBe('59s');
  });
  it('minutos cheios quando os segundos arredondam para 0', () => {
    expect(fmtDur(60)).toBe('1m');
    expect(fmtDur(120)).toBe('2m');
  });
  it('minutos + segundos quando há resto', () => {
    expect(fmtDur(65)).toBe('1m 5s');
    expect(fmtDur(150)).toBe('2m 30s');
  });
});

describe('mapas de constantes', () => {
  it('healthColors cobre as 4 classes', () => {
    expect(Object.keys(healthColors)).toEqual(['saudavel', 'estavel', 'atencao', 'critico']);
  });
  it('metricLabels traduz métricas', () => {
    expect(metricLabels.margem_por_hora).toBe('Margem/Hora');
    expect(metricLabels.churn).toBe('Churn (%)');
  });
  it('statusColors tem entrada para cada status', () => {
    expect(statusColors.rascunho).toBeTruthy();
    expect(statusColors.ativo).toBeTruthy();
    expect(statusColors.concluido).toBeTruthy();
    expect(statusColors.cancelado).toBeTruthy();
  });
});
