import { describe, it, expect } from 'vitest';
import { distanciaKm, amostrarPorUf, resumoMedicao, type AmostraMedida } from './medicao';

describe('distanciaKm (haversine)', () => {
  it('mesmo ponto → 0', () => {
    expect(distanciaKm(-20.14, -44.88, -20.14, -44.88)).toBe(0);
  });
  it('1° de latitude ≈ 111,19 km', () => {
    expect(distanciaKm(0, 0, 1, 0)).toBeCloseTo(111.19, 1);
  });
  it('1° de longitude no equador ≈ 111,19 km', () => {
    expect(distanciaKm(0, 0, 0, 1)).toBeCloseTo(111.19, 1);
  });
  it('simétrica', () => {
    const ab = distanciaKm(-20.14, -44.88, -23.55, -46.63);
    const ba = distanciaKm(-23.55, -46.63, -20.14, -44.88);
    expect(ab).toBeCloseTo(ba, 6);
  });
  it('Divinópolis↔São Paulo ≈ 430 km (sanidade)', () => {
    expect(distanciaKm(-20.14, -44.88, -23.55, -46.63)).toBeGreaterThan(400);
    expect(distanciaKm(-20.14, -44.88, -23.55, -46.63)).toBeLessThan(460);
  });
});

describe('amostrarPorUf (estratificada determinística)', () => {
  const itens = [
    { uf: 'MG', cep: '1' }, { uf: 'MG', cep: '2' }, { uf: 'MG', cep: '3' },
    { uf: 'SP', cep: '4' }, { uf: 'sp', cep: '5' }, { uf: 'RJ', cep: '6' },
  ];
  it('limita nPorUf por UF, ordem estável', () => {
    expect(amostrarPorUf(itens, 2).map((i) => i.cep)).toEqual(['1', '2', '4', '5', '6']);
  });
  it('uppercase une mg/MG no mesmo balde', () => {
    expect(amostrarPorUf([{ uf: 'mg', cep: 'a' }, { uf: 'MG', cep: 'b' }], 1).map((i) => i.cep)).toEqual(['a']);
  });
  it('nPorUf 0 → vazio', () => {
    expect(amostrarPorUf(itens, 0)).toEqual([]);
  });
});

describe('resumoMedicao', () => {
  const mk = (coberto: boolean, distanciaKm: number | null): AmostraMedida => ({ coberto, distanciaKm });
  it('cobertura %, mediana, p90 e grosseiros (>10km)', () => {
    const amostras = [
      mk(true, 0.2), mk(true, 0.5), mk(true, 1.0), mk(true, 2.0),
      mk(true, 15.0), // grosseiro (erro de cidade)
      mk(false, null), mk(false, null), // não cobertos
    ];
    const r = resumoMedicao(amostras);
    expect(r.total).toBe(7);
    expect(r.cobertos).toBe(5);
    expect(r.coberturaPct).toBeCloseTo(71.4, 1);
    expect(r.comReferencia).toBe(5);
    expect(r.grosseirosMaior10km).toBe(1);
    expect(r.distMedianaKm).not.toBeNull();
    expect(r.distP90Km).not.toBeNull();
  });
  it('vazio → zeros e nulls (ausente ≠ fabricar)', () => {
    const r = resumoMedicao([]);
    expect(r).toEqual({
      total: 0, cobertos: 0, coberturaPct: 0, comReferencia: 0,
      distMedianaKm: null, distP90Km: null, grosseirosMaior10km: 0,
    });
  });
  it('coberto sem referência não entra na distância', () => {
    const r = resumoMedicao([{ coberto: true, distanciaKm: null }]);
    expect(r.cobertos).toBe(1);
    expect(r.comReferencia).toBe(0);
    expect(r.distMedianaKm).toBeNull();
  });
});
