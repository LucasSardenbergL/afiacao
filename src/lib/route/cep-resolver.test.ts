import { describe, it, expect } from 'vitest';
import { interpretarResolver } from './cep-resolver';

describe('interpretarResolver', () => {
  it('adota coord quando resolved=true com lat/lng finitos', () => {
    expect(
      interpretarResolver({ resolved: true, lat: -20.1, lng: -44.8, precision: 'postcode_centroid' }),
    ).toEqual({ lat: -20.1, lng: -44.8, precisao: 'postcode_centroid' });
  });

  it('preserva a precisão vinda do cache (ex.: rooftop)', () => {
    expect(interpretarResolver({ resolved: true, lat: 1, lng: 2, precision: 'rooftop', cached: true })).toEqual({
      lat: 1,
      lng: 2,
      precisao: 'rooftop',
    });
  });

  it('default postcode_centroid quando precision ausente', () => {
    expect(interpretarResolver({ resolved: true, lat: 1, lng: 2 })).toEqual({
      lat: 1,
      lng: 2,
      precisao: 'postcode_centroid',
    });
  });

  it('retorna null no miss (resolved=false) → worker mantém centróide', () => {
    expect(interpretarResolver({ resolved: false })).toBeNull();
  });

  it('NÃO fabrica pino: resolved=true mas lat/lng null → null', () => {
    expect(interpretarResolver({ resolved: true, lat: null, lng: null })).toBeNull();
  });

  it('NÃO fabrica pino: lat/lng não-finito (NaN/Infinity) → null', () => {
    expect(interpretarResolver({ resolved: true, lat: NaN, lng: 2 })).toBeNull();
    expect(interpretarResolver({ resolved: true, lat: 1, lng: Infinity })).toBeNull();
  });

  it('rejeita lat/lng como string (sem coerção implícita = sem número fabricado)', () => {
    expect(interpretarResolver({ resolved: true, lat: '-20.1', lng: '-44.8' })).toBeNull();
  });

  it('entrada inválida (null/undefined/string/number/array) → null', () => {
    expect(interpretarResolver(null)).toBeNull();
    expect(interpretarResolver(undefined)).toBeNull();
    expect(interpretarResolver('x')).toBeNull();
    expect(interpretarResolver(42)).toBeNull();
    expect(interpretarResolver([])).toBeNull();
  });
});
