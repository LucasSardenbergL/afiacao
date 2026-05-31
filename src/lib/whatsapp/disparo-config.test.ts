import { describe, it, expect } from 'vitest';
import { formToConfig, configToForm, isValidHHMM } from './disparo-config';
import type { ConfigForm } from './disparo-config';

const FORM: ConfigForm = {
  disparoInicio: '07:30', disparoCorte: '15:30', metaTierCap: '1000',
  winBackReservaPercent: '20', coldStartPisoDia: '3', capacidadeLigacoesDia: '40', cadenciaMinDias: '3',
};

describe('isValidHHMM', () => {
  it('aceita horas válidas', () => {
    expect(isValidHHMM('07:30')).toBe(true);
    expect(isValidHHMM('00:00')).toBe(true);
    expect(isValidHHMM('23:59')).toBe(true);
  });
  it('rejeita inválidas', () => {
    expect(isValidHHMM('24:00')).toBe(false);
    expect(isValidHHMM('7:30')).toBe(false);
    expect(isValidHHMM('99:99')).toBe(false);
    expect(isValidHHMM('abc')).toBe(false);
    expect(isValidHHMM('')).toBe(false);
  });
});

describe('formToConfig', () => {
  it('converte % de win-back (0-100) → fração (0-1)', () => {
    expect(formToConfig({ ...FORM, winBackReservaPercent: '20' }).win_back_reserva_pct).toBeCloseTo(0.2, 5);
  });
  it('clampa % fora de [0,100]', () => {
    expect(formToConfig({ ...FORM, winBackReservaPercent: '150' }).win_back_reserva_pct).toBe(1);
    expect(formToConfig({ ...FORM, winBackReservaPercent: '-10' }).win_back_reserva_pct).toBe(0);
  });
  it('coerce inteiros ≥ 0 (não-número vira 0; decimal trunca)', () => {
    expect(formToConfig({ ...FORM, capacidadeLigacoesDia: '40' }).capacidade_ligacoes_dia).toBe(40);
    expect(formToConfig({ ...FORM, capacidadeLigacoesDia: '-5' }).capacidade_ligacoes_dia).toBe(0);
    expect(formToConfig({ ...FORM, capacidadeLigacoesDia: 'abc' }).capacidade_ligacoes_dia).toBe(0);
    expect(formToConfig({ ...FORM, coldStartPisoDia: '2.9' }).cold_start_piso_dia).toBe(2);
  });
  it('hora inválida cai pro default (inicio 07:30 / corte 15:30)', () => {
    expect(formToConfig({ ...FORM, disparoInicio: '99:99' }).disparo_inicio).toBe('07:30');
    expect(formToConfig({ ...FORM, disparoCorte: 'xx' }).disparo_corte).toBe('15:30');
  });
  it('hora válida é preservada', () => {
    expect(formToConfig({ ...FORM, disparoInicio: '08:15' }).disparo_inicio).toBe('08:15');
  });
});

describe('configToForm', () => {
  it('mostra a fração como % (0-1 → 0-100) e numéricos como string', () => {
    const form = configToForm({
      disparo_inicio: '07:30', disparo_corte: '15:30', meta_tier_cap: 1000,
      win_back_reserva_pct: 0.2, cold_start_piso_dia: 3, capacidade_ligacoes_dia: 40, cadencia_min_dias: 3,
    });
    expect(form.winBackReservaPercent).toBe('20');
    expect(form.capacidadeLigacoesDia).toBe('40');
    expect(form.disparoInicio).toBe('07:30');
  });
  it('round-trip form→config→form preserva', () => {
    expect(configToForm(formToConfig(FORM))).toEqual(FORM);
  });
});
