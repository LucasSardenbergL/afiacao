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
  // ai-ops-agent (P0-B-bis ponta 3): resolve farmer_id da carteira com fallback NULL. Trava a semântica
  // anti-circular do BUG-1 (o edge antigo fazia farmer_id = customer_user_id → cliente era dono de si).
  it('ai-ops: o dono é o VENDEDOR (não o cliente); fora da carteira → null, nunca o próprio id', () => {
    const m = buildOwnerMap([{ customer_user_id: 'cliente-x', owner_user_id: 'vendedora-ana' }]);
    expect(resolveOwner(m, 'cliente-x', null)).toBe('vendedora-ana');
    expect(resolveOwner(m, 'cliente-x', null)).not.toBe('cliente-x');
    expect(resolveOwner(m, 'cliente-orfao', null)).toBeNull();
  });
});
