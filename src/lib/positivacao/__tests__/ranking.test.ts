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

  it('desempate por potencial é transitivo quando só um lado é medido (ausente empurra pro fim, não pula o critério)', () => {
    // Mesmo priority_score → decide no desempate por potencial. Triplete real que formava ciclo
    // quando "ausente" pulava pro churn_risk em vez de perder dentro do próprio critério:
    // compare(A,C) por potencial (A>C), compare(A,B) e compare(B,C) por churn (B>A, C>B) → A>C>B>A.
    const A = c({ customer_user_id: 'A', priority_score: 50, revenue_potential: 100, churn_risk: 0 });
    const B = c({ customer_user_id: 'B', priority_score: 50, revenue_potential: null, churn_risk: 50 });
    const C = c({ customer_user_id: 'C', priority_score: 50, revenue_potential: 1, churn_risk: 100 });

    // A ordem final não pode depender da ordem de entrada — um comparador não-transitivo dá
    // ordem dependente da implementação do sort (money-path: prova por >1 permutação).
    for (const entrada of [[A, B, C], [B, C, A], [C, A, B], [C, B, A], [B, A, C], [A, C, B]]) {
      const out = rankAPositivar(entrada);
      expect(out.map((x) => x.customer_user_id)).toEqual(['A', 'C', 'B']);
    }
  });
});
