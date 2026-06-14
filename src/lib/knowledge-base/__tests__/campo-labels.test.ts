import { describe, it, expect } from 'vitest';
import { rotularCampo, formatarValorCampo, rotularChangeType, CAMPO_LABEL } from '@/lib/knowledge-base/campo-labels';

describe('rotularCampo', () => {
  it('campo conhecido → rótulo pt-BR', () => {
    expect(rotularCampo('rendimento_m2_por_litro')).toBe('Rendimento (m²/L)');
    expect(rotularCampo('catalisador_proporcao_pct')).toBe('Catalisador (%)');
  });
  it('campo desconhecido → o próprio nome (fallback, nunca quebra)', () => {
    expect(rotularCampo('campo_inexistente_xyz')).toBe('campo_inexistente_xyz');
  });
});

describe('formatarValorCampo', () => {
  it('array não-vazio → join " · "', () => {
    expect(formatarValorCampo(['mdf', 'mdp'])).toBe('mdf · mdp');
  });
  it('array vazio → "—"', () => {
    expect(formatarValorCampo([])).toBe('—');
  });
  it('null/undefined/"" → "—"', () => {
    expect(formatarValorCampo(null)).toBe('—');
    expect(formatarValorCampo(undefined)).toBe('—');
    expect(formatarValorCampo('')).toBe('—');
  });
  it('número → string', () => {
    expect(formatarValorCampo(365)).toBe('365');
    expect(formatarValorCampo(0)).toBe('0'); // zero é valor, não vazio
  });
  it('string → ela mesma', () => {
    expect(formatarValorCampo('CA.30')).toBe('CA.30');
  });
});

describe('rotularChangeType', () => {
  it('mapeia os 4 tipos', () => {
    expect(rotularChangeType('initial')).toBe('Versão inicial');
    expect(rotularChangeType('bulletin_revision')).toBe('Boletim revisado');
    expect(rotularChangeType('correction')).toBe('Correção');
    expect(rotularChangeType('data_completion')).toBe('Dados completados');
  });
  it('tipo desconhecido → fallback ao próprio valor', () => {
    expect(rotularChangeType('zzz')).toBe('zzz');
  });
});

describe('CAMPO_LABEL cobre os campos importantes da completude', () => {
  it('todo campo importante tem rótulo', () => {
    for (const c of ['rendimento_m2_por_litro', 'catalisador_codigo', 'validade_dias', 'pot_life_horas', 'diluente_codigo', 'substrato']) {
      expect(CAMPO_LABEL[c]).toBeTruthy();
    }
  });
});
