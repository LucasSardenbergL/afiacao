import { describe, it, expect } from 'vitest';
import { rankAPositivar } from '../ranking';
import type { ClienteAPositivar } from '../types';

const c = (over: Partial<ClienteAPositivar>): ClienteAPositivar => ({
  customer_user_id: 'x',
  nome: null,
  revenue_potential: 0,
  churn_risk: 0,
  recover_score: 0,
  days_since_last_purchase: 0,
  priority_score: 0,
  ...over,
});

describe('rankAPositivar', () => {
  it('prioriza maior priority_score, depois maior revenue_potential', () => {
    const out = rankAPositivar([
      c({ customer_user_id: 'a', priority_score: 10, revenue_potential: 100 }),
      c({ customer_user_id: 'b', priority_score: 90, revenue_potential: 1 }),
      c({ customer_user_id: 'c', priority_score: 90, revenue_potential: 500 }),
    ]);
    expect(out.map((x) => x.customer_user_id)).toEqual(['c', 'b', 'a']);
  });

  it('não muta o array de entrada', () => {
    const input = [
      c({ customer_user_id: 'a', priority_score: 1 }),
      c({ customer_user_id: 'b', priority_score: 2 }),
    ];
    rankAPositivar(input);
    expect(input.map((x) => x.customer_user_id)).toEqual(['a', 'b']);
  });
});
