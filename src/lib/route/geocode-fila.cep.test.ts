import { describe, it, expect } from 'vitest';
import { ordenarFilaGeocodeCep, type EstadoFilaCep } from './geocode-fila';
import type { RouteStop } from '@/components/reposicao/routePlanner/types';

// Stop com CEP + precisão controlados (o que a fila por CEP olha).
const mk = (
  id: string,
  zip: string,
  precisao: string | undefined,
  over: Partial<RouteStop> = {},
): RouteStop => ({
  id, stopType: 'prospect_visit', customerUserId: '', customerName: id, phone: null,
  address: { street: 'Rua', number: '1', neighborhood: 'B', city: 'Divinópolis', state: 'MG', zip_code: zip },
  timeSlot: null, businessHoursOpen: null, businessHoursClose: null, status: 'prospect',
  visitReason: '', priorityScore: 0, priorityLabel: 'baixa', priorityFactors: [], precisao, ...over,
});
const vazio = (): EstadoFilaCep => ({ resolvidos: new Set(), falhados: new Set(), marcados: new Set() });

describe('ordenarFilaGeocodeCep', () => {
  it('deduplica por CEP distinto (3 stops, 2 CEPs → 2 entradas)', () => {
    const stops = [
      mk('a', '35500-001', 'city_centroid'),
      mk('b', '35500001', 'city_centroid'), // mesmo CEP normalizado que 'a'
      mk('c', '35501-000', null),
    ];
    const fila = ordenarFilaGeocodeCep(stops, vazio());
    expect(fila.map((f) => f.cep)).toEqual(['35500001', '35501000']);
  });

  it('só inclui precisão aproximada (city_centroid/null) — pula street/postcode/rooftop', () => {
    const stops = [
      mk('bom1', '35500-001', 'street'),
      mk('bom2', '35501-000', 'postcode_centroid'),
      mk('bom3', '35502-000', 'rooftop'),
      mk('aprox', '35503-000', 'city_centroid'),
    ];
    const fila = ordenarFilaGeocodeCep(stops, vazio());
    expect(fila.map((f) => f.cep)).toEqual(['35503000']);
  });

  it('exclui CEP já resolvido ou já falhado nesta sessão', () => {
    const stops = [
      mk('a', '35500-001', 'city_centroid'),
      mk('b', '35501-000', 'city_centroid'),
      mk('c', '35502-000', 'city_centroid'),
    ];
    const estado: EstadoFilaCep = {
      resolvidos: new Set(['35500001']),
      falhados: new Set(['35501000']),
      marcados: new Set(),
    };
    expect(ordenarFilaGeocodeCep(stops, estado).map((f) => f.cep)).toEqual(['35502000']);
  });

  it('exclui CEP inválido (não-8-dígitos) — fora da fila', () => {
    const stops = [
      mk('curto', '123', 'city_centroid'),
      mk('vazio', '', 'city_centroid'),
      mk('ok', '35500-001', 'city_centroid'),
    ];
    expect(ordenarFilaGeocodeCep(stops, vazio()).map((f) => f.cep)).toEqual(['35500001']);
  });

  it('CEPs com algum stop marcado vêm primeiro (CEP herda prioridade)', () => {
    const stops = [
      mk('a', '35500-001', 'city_centroid'),
      mk('b', '35501-000', 'city_centroid'),
      mk('c', '35502-000', 'city_centroid'),
    ];
    const estado: EstadoFilaCep = { ...vazio(), marcados: new Set(['c']) };
    expect(ordenarFilaGeocodeCep(stops, estado).map((f) => f.cep)).toEqual(['35502000', '35500001', '35501000']);
  });

  it('leva cidade/uf do 1º stop do CEP p/ a query do Nominatim', () => {
    const fila = ordenarFilaGeocodeCep([mk('a', '35500-001', 'city_centroid')], vazio());
    expect(fila[0]).toEqual({ cep: '35500001', cidade: 'Divinópolis', uf: 'MG' });
  });

  it('estável: dentro de cada grupo preserva a ordem de 1ª aparição (prioridade da RPC)', () => {
    const stops = [
      mk('a', '35503-000', 'city_centroid'),
      mk('b', '35501-000', 'city_centroid'),
      mk('c', '35502-000', 'city_centroid'),
    ];
    expect(ordenarFilaGeocodeCep(stops, vazio()).map((f) => f.cep)).toEqual(['35503000', '35501000', '35502000']);
  });
});
