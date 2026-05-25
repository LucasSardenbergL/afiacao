// src/lib/carteira/__tests__/owner-map.test.ts
import { describe, it, expect } from 'vitest';
import { buildOwnerMap, resolveOwner } from '../owner-map';

describe('owner-map (anti-drift: score vem da carteira, não de atividade)', () => {
  it('buildOwnerMap monta customer→owner', () => {
    const m = buildOwnerMap([
      { customer_user_id: 'c1', owner_user_id: 'regina' },
      { customer_user_id: 'c2', owner_user_id: 'tati' },
    ]);
    expect(m.get('c1')).toBe('regina');
    expect(m.get('c2')).toBe('tati');
  });
  it('resolveOwner usa a carteira; fallback só se cliente não estiver na carteira', () => {
    const m = buildOwnerMap([{ customer_user_id: 'c1', owner_user_id: 'regina' }]);
    expect(resolveOwner(m, 'c1', 'hunter')).toBe('regina');
    expect(resolveOwner(m, 'desconhecido', 'hunter')).toBe('hunter');
  });
});
