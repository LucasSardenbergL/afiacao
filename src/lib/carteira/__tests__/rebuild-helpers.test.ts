// src/lib/carteira/__tests__/rebuild-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { computeCarteira } from '../rebuild-helpers';

const HUNTER = 'hunter-uid';

describe('computeCarteira', () => {
  it('código mapeado p/ 1 vendedor → assignment source=omie', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c1', omie_codigo_vendedor: 10 }],
      [{ omie_codigo_vendedor: 10, user_id: 'regina' }],
      HUNTER,
    );
    expect(r.assignments).toEqual([
      { customer_user_id: 'c1', owner_user_id: 'regina', source: 'omie', omie_codigo_vendedor: 10 },
    ]);
    expect(r.conflicts).toHaveLength(0);
    expect(r.orphanCount).toBe(0);
  });

  it('código null → órfão vai pro Hunter (hunter_orphan)', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c2', omie_codigo_vendedor: null }],
      [{ omie_codigo_vendedor: 10, user_id: 'regina' }],
      HUNTER,
    );
    expect(r.assignments).toEqual([
      { customer_user_id: 'c2', owner_user_id: HUNTER, source: 'hunter_orphan', omie_codigo_vendedor: null },
    ]);
    expect(r.orphanCount).toBe(1);
  });

  it('código presente mas NÃO mapeado → órfão vai pro Hunter', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c3', omie_codigo_vendedor: 99 }],
      [{ omie_codigo_vendedor: 10, user_id: 'regina' }],
      HUNTER,
    );
    expect(r.assignments[0]).toEqual({
      customer_user_id: 'c3', owner_user_id: HUNTER, source: 'hunter_orphan', omie_codigo_vendedor: 99,
    });
    expect(r.orphanCount).toBe(1);
  });

  it('código que mapeia p/ 2 vendedores distintos → conflito, sem assignment', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c4', omie_codigo_vendedor: 10 }],
      [
        { omie_codigo_vendedor: 10, user_id: 'regina' },
        { omie_codigo_vendedor: 10, user_id: 'tati' },
      ],
      HUNTER,
    );
    expect(r.assignments).toHaveLength(0);
    expect(r.conflicts).toEqual([
      { customer_user_id: 'c4', omie_codigo_vendedor: 10, candidate_user_ids: ['regina', 'tati'] },
    ]);
  });

  it('sem Hunter (null) → órfão é contado mas não vira assignment', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c5', omie_codigo_vendedor: null }],
      [],
      null,
    );
    expect(r.assignments).toHaveLength(0);
    expect(r.orphanCount).toBe(1);
  });
});
