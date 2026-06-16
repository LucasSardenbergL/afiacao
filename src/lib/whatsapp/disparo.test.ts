import { describe, it, expect } from 'vitest';
import { selectDisparoBatch } from './disparo';
import type { DisparoCandidate, DisparoConfig } from './disparo';

function c(id: string, valor: number, optIn = 'opt_in'): DisparoCandidate {
  return { customerUserId: id, valorDaLigacao: valor, optInStatus: optIn };
}
const CFG: DisparoConfig = { metaTierCap: 1000, disparoInicio: '07:30', disparoCorte: '15:30', jaEnviadosHoje: 0 };

describe('selectDisparoBatch — janela de horário', () => {
  it('antes do início → pausa fora_da_janela', () => {
    const r = selectDisparoBatch([c('a', 100)], CFG, '07:00');
    expect(r.enviarAgora).toEqual([]);
    expect(r.motivoPausa).toBe('fora_da_janela');
  });
  it('depois do corte → pausa fora_da_janela', () => {
    const r = selectDisparoBatch([c('a', 100)], CFG, '16:00');
    expect(r.enviarAgora).toEqual([]);
    expect(r.motivoPausa).toBe('fora_da_janela');
  });
  it('dentro da janela → envia', () => {
    const r = selectDisparoBatch([c('a', 100)], CFG, '09:00');
    expect(r.enviarAgora.map(x => x.customerUserId)).toEqual(['a']);
    expect(r.motivoPausa).toBeNull();
  });
  it('início e corte são inclusivos', () => {
    expect(selectDisparoBatch([c('a', 100)], CFG, '07:30').enviarAgora.length).toBe(1);
    expect(selectDisparoBatch([c('a', 100)], CFG, '15:30').enviarAgora.length).toBe(1);
  });
});

describe('selectDisparoBatch — opt-in e teto do tier', () => {
  it('exclui opt_out; inclui opt_in e unknown (primeiro toque)', () => {
    const r = selectDisparoBatch([c('a', 100, 'opt_in'), c('b', 90, 'opt_out'), c('u', 80, 'unknown')], CFG, '09:00');
    expect(r.enviarAgora.map(x => x.customerUserId)).toEqual(['a', 'u']);
  });
  it('respeita o cap e sinaliza cap_atingido, preservando a ordem por valor', () => {
    const q = [c('a', 300), c('b', 200), c('c', 100)];
    const r = selectDisparoBatch(q, { ...CFG, metaTierCap: 2 }, '09:00');
    expect(r.enviarAgora.map(x => x.customerUserId)).toEqual(['a', 'b']);
    expect(r.motivoPausa).toBe('cap_atingido');
  });
  it('desconta o já enviado hoje do cap', () => {
    const q = [c('a', 300), c('b', 200)];
    const r = selectDisparoBatch(q, { ...CFG, metaTierCap: 5, jaEnviadosHoje: 4 }, '09:00');
    expect(r.enviarAgora.map(x => x.customerUserId)).toEqual(['a']);
    expect(r.motivoPausa).toBe('cap_atingido');
  });
  it('cap já esgotado → nada, cap_atingido', () => {
    const r = selectDisparoBatch([c('a', 100)], { ...CFG, metaTierCap: 3, jaEnviadosHoje: 3 }, '09:00');
    expect(r.enviarAgora).toEqual([]);
    expect(r.motivoPausa).toBe('cap_atingido');
  });
  it('fila vazia dentro da janela → nada, sem motivo de pausa', () => {
    const r = selectDisparoBatch([], CFG, '09:00');
    expect(r.enviarAgora).toEqual([]);
    expect(r.motivoPausa).toBeNull();
  });
  it('todos opt_out dentro da janela → nada, sem cap_atingido (não havia elegível)', () => {
    const r = selectDisparoBatch([c('a', 100, 'opt_out'), c('b', 90, 'opt_out')], CFG, '09:00');
    expect(r.enviarAgora).toEqual([]);
    expect(r.motivoPausa).toBeNull();
  });
});
