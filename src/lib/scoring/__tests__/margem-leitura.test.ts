import { describe, it, expect } from 'vitest';
import { tomMargem, mediaMargem } from '../margem-leitura';

describe('tomMargem — thresholds em escala 0–100', () => {
  it('classifica pela escala 0–100, não por fração', () => {
    // Com os thresholds antigos (>= 0.3), 53,47 e 0,8 cairiam AMBOS em success.
    expect(tomMargem(53.47)).toBe('success');
    expect(tomMargem(30)).toBe('success');
    expect(tomMargem(20)).toBe('warning');
    expect(tomMargem(15)).toBe('warning');
    expect(tomMargem(5)).toBe('error');
  });

  it('margem de 0,8% é ruim (error) — sob os thresholds de fração seria success', () => {
    expect(tomMargem(0.8)).toBe('error');
  });

  it('prejuízo é error', () => {
    expect(tomMargem(-143.22)).toBe('error');
  });

  it('desconhecida é neutral, NÃO error — não acusar o cliente do que não medimos', () => {
    expect(tomMargem(null)).toBe('neutral');
    expect(tomMargem(undefined)).toBe('neutral');
    expect(tomMargem('')).toBe('neutral');
  });

  it('zero medido é error — veredito real, distinto de ausência', () => {
    expect(tomMargem(0)).toBe('error');
  });
});

describe('mediaMargem — só sobre conhecidas, com cobertura exposta', () => {
  it('ignora ausentes no numerador E no denominador', () => {
    // O bug que isto substitui somaria 0 e dividiria por 3 → 50.
    const r = mediaMargem([50, null, 100]);
    expect(r.media).toBe(75);
    expect(r.conhecidas).toBe(2);
    expect(r.total).toBe(3);
  });

  it('expõe a cobertura para a tela não fingir que fala da carteira inteira', () => {
    const carteira = [...Array(1052).fill(50), ...Array(162).fill(null)];
    const r = mediaMargem(carteira);
    expect(r.media).toBe(50);
    expect(r.conhecidas).toBe(1052);
    expect(r.total).toBe(1214);
  });

  it('nenhuma conhecida → media null, nunca 0', () => {
    const r = mediaMargem([null, undefined, '']);
    expect(r.media).toBeNull();
    expect(r.conhecidas).toBe(0);
    expect(r.total).toBe(3);
  });

  it('lista vazia → media null', () => {
    expect(mediaMargem([]).media).toBeNull();
  });

  it('zeros medidos ENTRAM na média — zero é dado, ausência não é', () => {
    const r = mediaMargem([0, 100]);
    expect(r.media).toBe(50);
    expect(r.conhecidas).toBe(2);
  });

  it('negativos entram na média (cliente no prejuízo puxa o KPI, corretamente)', () => {
    const r = mediaMargem([-50, 50]);
    expect(r.media).toBe(0);
    expect(r.conhecidas).toBe(2);
  });
});
