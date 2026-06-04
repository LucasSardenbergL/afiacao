import { describe, it, expect } from 'vitest';
import { marcarSeNovoNoDia, resumoFontes } from '../telemetria';
import type { AcaoSugerida } from '../types';

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size; },
  } as Storage;
}

describe('marcarSeNovoNoDia', () => {
  it('retorna true na 1ª vez e false nas seguintes (idempotente)', () => {
    const s = fakeStorage();
    expect(marcarSeNovoNoDia('fila_exibida_2026-06-04', s)).toBe(true);
    expect(marcarSeNovoNoDia('fila_exibida_2026-06-04', s)).toBe(false);
    expect(marcarSeNovoNoDia('fila_exibida_2026-06-05', s)).toBe(true);
  });
  it('storage que lança (throw) → não quebra, retorna false', () => {
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } } as unknown as Storage;
    expect(marcarSeNovoNoDia('k', bad)).toBe(false);
  });
});

describe('resumoFontes', () => {
  it('conta por fonte', () => {
    const acoes = [
      { fonte: 'tarefa' }, { fonte: 'tarefa' }, { fonte: 'rota' }, { fonte: 'mixgap' },
    ] as AcaoSugerida[];
    expect(resumoFontes(acoes)).toEqual({ tarefa: 2, rota: 1, mixgap: 1 });
  });
  it('lista vazia → objeto vazio', () => {
    expect(resumoFontes([])).toEqual({});
  });
});
