import { describe, it, expect } from 'vitest';
import { ordenarFilaGeocode } from './geocode-fila';
import type { RouteStop } from '@/components/reposicao/routePlanner/types';

const stop = (id: string, over: Partial<RouteStop> = {}): RouteStop => ({
  id, stopType: 'prospect_visit', customerUserId: '', customerName: id, phone: null,
  address: { street: 'Rua', number: '1', neighborhood: 'B', city: 'C', state: 'MG', zip_code: '' },
  timeSlot: null, businessHoursOpen: null, businessHoursClose: null, status: 'prospect',
  visitReason: '', priorityScore: 0, priorityLabel: 'baixa', priorityFactors: [], ...over,
});
const vazio = { resolvidos: new Set<string>(), falhados: new Set<string>(), marcados: new Set<string>() };

describe('ordenarFilaGeocode', () => {
  it('exclui sem-rua, resolvidos, falhados e com-coord', () => {
    const stops = [
      stop('a'),
      stop('semrua', { address: { ...stop('x').address, street: '' } }),
      stop('resolvido'),
      stop('falhou'),
      stop('jaTemCoord', { lat: -20, lng: -44 }),
    ];
    const fila = ordenarFilaGeocode(stops, {
      resolvidos: new Set(['resolvido']),
      falhados: new Set(['falhou']),
      marcados: new Set(),
    });
    expect(fila.map((s) => s.id)).toEqual(['a']);
  });

  it('marcados primeiro, mantendo ordem original dentro de cada grupo', () => {
    const stops = [stop('a'), stop('b'), stop('c'), stop('d')];
    const fila = ordenarFilaGeocode(stops, { ...vazio, marcados: new Set(['c']) });
    expect(fila.map((s) => s.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('vários marcados preservam a ordem da lista entre eles', () => {
    const stops = [stop('a'), stop('b'), stop('c'), stop('d')];
    const fila = ordenarFilaGeocode(stops, { ...vazio, marcados: new Set(['d', 'b']) });
    expect(fila.map((s) => s.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('sem marcados → ordem da lista (já vem por prioridade)', () => {
    const stops = [stop('a'), stop('b'), stop('c')];
    expect(ordenarFilaGeocode(stops, vazio).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('exclui geocodeFailed persistido (não re-tenta known-failure)', () => {
    const stops = [stop('a'), stop('falhouAntes', { geocodeFailed: true })];
    expect(ordenarFilaGeocode(stops, vazio).map((s) => s.id)).toEqual(['a']);
  });

  it('lat null (não só undefined) também conta como pendente', () => {
    const stops = [stop('a', { lat: null as unknown as undefined, lng: null as unknown as undefined })];
    expect(ordenarFilaGeocode(stops, vazio).map((s) => s.id)).toEqual(['a']);
  });
});
