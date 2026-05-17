import { describe, it, expect } from 'vitest';
import { aggregateCustomerProfile } from './aggregate-customer-profile';
import type { CustomerCallRow } from '@/hooks/useCustomerCalls';

const call = (overrides: Partial<CustomerCallRow> = {}): CustomerCallRow => ({
  id: `call-${Math.random()}`,
  farmer_id: 'f1',
  customer_user_id: 'c1',
  phone_dialed: '31999991234',
  call_backend: 'webrtc',
  started_at: '2026-05-17T10:00:00Z',
  ended_at: '2026-05-17T10:18:00Z',
  duration_seconds: 1080,
  call_result: 'atendeu',
  call_type: 'venda',
  revenue_generated: 0,
  margin_generated: 0,
  notes: null,
  transcript: [],
  analyses: [],
  entities_extracted: [],
  ...overrides,
});

describe('aggregateCustomerProfile', () => {
  it('array vazio retorna profile zerado', () => {
    const p = aggregateCustomerProfile([]);
    expect(p.totalCalls).toBe(0);
    expect(p.totalDurationSeconds).toBe(0);
    expect(p.totalRevenue).toBe(0);
    expect(p.avgTicket).toBe(0);
    expect(p.competitorsMentioned).toEqual([]);
    expect(p.pricesReferenced).toEqual([]);
    expect(p.topObjections).toEqual([]);
  });

  it('soma duration, revenue, margin', () => {
    const p = aggregateCustomerProfile([
      call({ duration_seconds: 600, revenue_generated: 1000, margin_generated: 300 }),
      call({ duration_seconds: 900, revenue_generated: 2000, margin_generated: 600 }),
    ]);
    expect(p.totalCalls).toBe(2);
    expect(p.totalDurationSeconds).toBe(1500);
    expect(p.totalRevenue).toBe(3000);
    expect(p.totalMargin).toBe(900);
    expect(p.avgTicket).toBe(1500); // 3000/2
  });

  it('avgTicket ignora chamadas com revenue 0 ou null', () => {
    const p = aggregateCustomerProfile([
      call({ revenue_generated: 1000 }),
      call({ revenue_generated: 0 }),
      call({ revenue_generated: null }),
      call({ revenue_generated: 2000 }),
    ]);
    expect(p.avgTicket).toBe(1500); // (1000+2000)/2
  });

  it('agrega competitors únicos das entities das múltiplas chamadas', () => {
    const p = aggregateCustomerProfile([
      call({ entities_extracted: [
        { type: 'competitor', value: 'Farben', context: '', confidence: 0.8, occurrences: 1 },
        { type: 'price', value: 'R$ 35/L', context: '', confidence: 0.7, occurrences: 1 },
      ]}),
      call({ entities_extracted: [
        { type: 'competitor', value: 'farben', context: '', confidence: 0.9, occurrences: 2 },
        { type: 'competitor', value: 'Vernit', context: '', confidence: 0.7, occurrences: 1 },
      ]}),
    ]);
    expect(p.competitorsMentioned).toHaveLength(2);
    expect(p.competitorsMentioned.map(c => c.value).sort()).toEqual(['Farben', 'Vernit']);
    const farben = p.competitorsMentioned.find(c => c.value === 'Farben')!;
    expect(farben.totalOccurrences).toBe(3); // 1+2
  });

  it('extrai top objections de analyses[].risks', () => {
    const p = aggregateCustomerProfile([
      call({ analyses: [
        { risks: [
          { type: 'price_objection', severity: 'high', note: 'achou caro' },
          { type: 'price_objection', severity: 'medium', note: 'comparou com X' },
          { type: 'competitor_mentioned', severity: 'low', note: 'falou Farben' },
        ]},
      ]}),
    ]);
    expect(p.topObjections.length).toBeGreaterThan(0);
    const priceObj = p.topObjections.find(o => o.type === 'price_objection');
    expect(priceObj?.count).toBe(2);
  });

  it('lastCallAt é a data mais recente', () => {
    const p = aggregateCustomerProfile([
      call({ started_at: '2026-05-10T10:00:00Z' }),
      call({ started_at: '2026-05-17T10:00:00Z' }),
      call({ started_at: '2026-05-15T10:00:00Z' }),
    ]);
    expect(p.lastCallAt).toBe('2026-05-17T10:00:00Z');
  });
});
