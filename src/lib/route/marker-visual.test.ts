import { describe, it, expect } from 'vitest';
import { markerVisual, recenciaFaixa, clusterStats, precisaoVisual } from './marker-visual';
import type { RouteStop } from '@/components/reposicao/routePlanner/types';

const carteira = (over: Partial<RouteStop> = {}): RouteStop => ({
  id: 'c1', stopType: 'sales_visit', customerUserId: 'u1', customerName: 'X', phone: null,
  address: { street: 'R', number: '1', neighborhood: 'B', city: 'C', state: 'MG', zip_code: '' },
  timeSlot: null, businessHoursOpen: null, businessHoursClose: null, status: 'carteira',
  visitReason: '', priorityScore: 0, priorityLabel: 'baixa', priorityFactors: [], ...over,
});
const prospect = (over: Partial<RouteStop> = {}): RouteStop => carteira({
  id: 'p1', stopType: 'prospect_visit', status: 'prospect', prospeccaoStatus: 'a_contatar', ...over,
});

describe('recenciaFaixa', () => {
  it('null/undefined → nunca; limites 30/90', () => {
    expect(recenciaFaixa(null)).toBe('nunca');
    expect(recenciaFaixa(undefined)).toBe('nunca');
    expect(recenciaFaixa(0)).toBe('recente');
    expect(recenciaFaixa(30)).toBe('recente');
    expect(recenciaFaixa(31)).toBe('media');
    expect(recenciaFaixa(90)).toBe('media');
    expect(recenciaFaixa(91)).toBe('antiga');
  });
});

describe('markerVisual — carteira (círculo, cor=recência)', () => {
  it('≤30 verde, 31-90 âmbar, >90 vermelho, nunca cinza', () => {
    expect(markerVisual(carteira({ diasDesdeVisita: 10 }))).toEqual({ tone: 'success', shape: 'circle' });
    expect(markerVisual(carteira({ diasDesdeVisita: 60 }))).toEqual({ tone: 'warning', shape: 'circle' });
    expect(markerVisual(carteira({ diasDesdeVisita: 200 }))).toEqual({ tone: 'error', shape: 'circle' });
    expect(markerVisual(carteira({ diasDesdeVisita: null }))).toEqual({ tone: 'neutral', shape: 'circle' });
  });
});

describe('markerVisual — prospect (losango, cor=status)', () => {
  it('a_contatar azul, sem_resposta âmbar, em_conversa vermelho, desconhecido cinza', () => {
    expect(markerVisual(prospect({ prospeccaoStatus: 'a_contatar' }))).toEqual({ tone: 'info', shape: 'diamond' });
    expect(markerVisual(prospect({ prospeccaoStatus: 'contatado_sem_resposta' }))).toEqual({ tone: 'warning', shape: 'diamond' });
    expect(markerVisual(prospect({ prospeccaoStatus: 'em_conversa' }))).toEqual({ tone: 'error', shape: 'diamond' });
    expect(markerVisual(prospect({ prospeccaoStatus: 'xpto' }))).toEqual({ tone: 'neutral', shape: 'diamond' });
    expect(markerVisual(prospect({ prospeccaoStatus: undefined }))).toEqual({ tone: 'neutral', shape: 'diamond' });
  });
});

describe('clusterStats', () => {
  it('conta por tom, maior-urgência p/ borda, nº de vermelhos p/ badge', () => {
    const stops = [
      carteira({ id: 'a', diasDesdeVisita: 5 }),               // success
      carteira({ id: 'b', diasDesdeVisita: 200 }),             // error
      prospect({ id: 'c', prospeccaoStatus: 'em_conversa' }),  // error
      prospect({ id: 'd', prospeccaoStatus: 'a_contatar' }),   // info
    ];
    const st = clusterStats(stops);
    expect(st.total).toBe(4);
    expect(st.porTone.error).toBe(2);
    expect(st.porTone.success).toBe(1);
    expect(st.porTone.info).toBe(1);
    expect(st.maiorUrgencia).toBe('error');
    expect(st.vermelhos).toBe(2);
  });
  it('sem vermelhos: maior-urgência cai p/ warning, badge zero', () => {
    const st = clusterStats([carteira({ diasDesdeVisita: 60 }), carteira({ diasDesdeVisita: 5 })]);
    expect(st.maiorUrgencia).toBe('warning');
    expect(st.vermelhos).toBe(0);
  });
  it('vazio → neutral, zero', () => {
    const st = clusterStats([]);
    expect(st.total).toBe(0);
    expect(st.maiorUrgencia).toBe('neutral');
    expect(st.vermelhos).toBe(0);
  });
});

describe('precisaoVisual', () => {
  it('rooftop/street/postcode_centroid = bom → não aproximado, sem rótulo', () => {
    expect(precisaoVisual('rooftop')).toEqual({ aproximado: false, rotulo: '' });
    expect(precisaoVisual('street')).toEqual({ aproximado: false, rotulo: '' });
    expect(precisaoVisual('postcode_centroid')).toEqual({ aproximado: false, rotulo: '' });
  });

  it('city_centroid/unknown/null/undefined → aproximado + "aprox."', () => {
    expect(precisaoVisual('city_centroid')).toEqual({ aproximado: true, rotulo: 'aprox.' });
    expect(precisaoVisual('unknown')).toEqual({ aproximado: true, rotulo: 'aprox.' });
    expect(precisaoVisual(null)).toEqual({ aproximado: true, rotulo: 'aprox.' });
    expect(precisaoVisual(undefined)).toEqual({ aproximado: true, rotulo: 'aprox.' });
  });

  it('valor inesperado da RPC → degrada honesto p/ aproximado', () => {
    expect(precisaoVisual('xpto')).toEqual({ aproximado: true, rotulo: 'aprox.' });
  });
});
