import { describe, it, expect } from 'vitest';
import type { Tables } from '@/integrations/supabase/types';
import { decisaoDaLinha } from '../borda';

function linha(o: Partial<Tables<'ai_decisions'>> = {}): Tables<'ai_decisions'> {
  return {
    id: 'd1',
    decision_type: 'churn',
    customer_user_id: 'c1',
    farmer_id: null,
    score_final: 80,
    confidence: 'alta',
    confidence_value: 0.9,
    suggested_action: 'ligar',
    primary_reason: 'x',
    evidences: [{ label: 'Atraso', value: '15 dias', type: 'critical' }],
    explanation: null,
    executed_at: null,
    customer_metrics: { pedidos_90d: 5, intervalo_medio_dias: null, is_cold_start: false },
    status: 'pending',
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-01T00:00:00Z',
    ...o,
  };
}

describe('decisaoDaLinha', () => {
  it('lê evidências e só as métricas numéricas (NULL explícito fica; flag booleana sai)', () => {
    const d = decisaoDaLinha(linha());
    expect(d.evidences).toEqual([{ label: 'Atraso', value: '15 dias', type: 'critical' }]);
    expect(d.customer_metrics).toEqual({ pedidos_90d: 5, intervalo_medio_dias: null });
  });

  it('jsonb NULL é lista/objeto vazio', () => {
    const d = decisaoDaLinha(linha({ evidences: null, customer_metrics: null }));
    expect(d.evidences).toEqual([]);
    expect(d.customer_metrics).toEqual({});
  });

  it('evidência fora da forma lança, nomeando a decisão', () => {
    expect(() => decisaoDaLinha(linha({ evidences: [{ label: 'a', value: 'b', type: 'grave' }] }))).toThrow(
      'ai_decisions d1: evidência fora da forma',
    );
    expect(() => decisaoDaLinha(linha({ evidences: { label: 'a' } }))).toThrow('ai_decisions d1: evidences não é array');
    expect(() => decisaoDaLinha(linha({ customer_metrics: [1] }))).toThrow('ai_decisions d1: customer_metrics não é objeto');
  });
});
