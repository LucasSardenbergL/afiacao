// src/lib/carteira/__tests__/rebuild-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { computeCarteira } from '../rebuild-helpers';

const HUNTER = 'hunter-uid';

describe('computeCarteira (legado — aliasMap vazio)', () => {
  it('código mapeado p/ 1 vendedor → assignment source=omie, eligible=true', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c1', omie_codigo_vendedor: 10 }],
      [{ omie_codigo_vendedor: 10, user_id: 'regina' }],
      HUNTER,
    );
    expect(r.assignments).toEqual([
      { customer_user_id: 'c1', owner_user_id: 'regina', source: 'omie', omie_codigo_vendedor: 10, eligible: true },
    ]);
    expect(r.conflicts).toHaveLength(0);
    expect(r.orphanCount).toBe(0);
  });

  it('código null → órfão vai pro Hunter (hunter_orphan), eligible=true', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c2', omie_codigo_vendedor: null }],
      [{ omie_codigo_vendedor: 10, user_id: 'regina' }],
      HUNTER,
    );
    expect(r.assignments).toEqual([
      { customer_user_id: 'c2', owner_user_id: HUNTER, source: 'hunter_orphan', omie_codigo_vendedor: null, eligible: true },
    ]);
    expect(r.orphanCount).toBe(1);
  });

  it('código presente mas NÃO mapeado → órfão vai pro Hunter, preserva o código', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c3', omie_codigo_vendedor: 99 }],
      [{ omie_codigo_vendedor: 10, user_id: 'regina' }],
      HUNTER,
    );
    expect(r.assignments[0]).toEqual({
      customer_user_id: 'c3', owner_user_id: HUNTER, source: 'hunter_orphan', omie_codigo_vendedor: 99, eligible: true,
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

describe('computeCarteira (B-lite — canonicalização clone→gêmeo)', () => {
  const find = (r: ReturnType<typeof computeCarteira>, id: string) =>
    r.assignments.find((a) => a.customer_user_id === id);

  it('clone (com vendedor) + gêmeo (órfão) → gêmeo herda o vendedor e fica eligible=true; clone eligible=false', () => {
    const r = computeCarteira(
      [
        { customer_user_id: 'clone', omie_codigo_vendedor: 10 }, // cadastro Colacor SC, vendedor=regina
        { customer_user_id: 'gemeo', omie_codigo_vendedor: null }, // cadastro Oben, sem vendedor (com nome)
      ],
      [{ omie_codigo_vendedor: 10, user_id: 'regina' }],
      HUNTER,
      new Map([['clone', 'gemeo']]),
    );
    // gêmeo (canônico) vira o cliente visível, dono = vendedora do clone
    expect(find(r, 'gemeo')).toEqual({
      customer_user_id: 'gemeo', owner_user_id: 'regina', source: 'omie', omie_codigo_vendedor: 10, eligible: true,
    });
    // clone escondido (preservado)
    expect(find(r, 'clone')).toEqual({
      customer_user_id: 'clone', owner_user_id: 'regina', source: 'omie', omie_codigo_vendedor: 10, eligible: false,
    });
    expect(r.orphanCount).toBe(0); // o gêmeo deixou de ser órfão
  });

  it('cliente normal (fora do aliasMap) é inalterado e eligible=true', () => {
    const r = computeCarteira(
      [
        { customer_user_id: 'clone', omie_codigo_vendedor: 10 },
        { customer_user_id: 'gemeo', omie_codigo_vendedor: null },
        { customer_user_id: 'normal', omie_codigo_vendedor: 20 },
      ],
      [
        { omie_codigo_vendedor: 10, user_id: 'regina' },
        { omie_codigo_vendedor: 20, user_id: 'tati' },
      ],
      HUNTER,
      new Map([['clone', 'gemeo']]),
    );
    expect(find(r, 'normal')).toEqual({
      customer_user_id: 'normal', owner_user_id: 'tati', source: 'omie', omie_codigo_vendedor: 20, eligible: true,
    });
  });

  it('gêmeo com vendedor próprio + clone com OUTRO vendedor → conflito: NÃO canonicaliza, ambos VISÍVEIS (eligible=true)', () => {
    const r = computeCarteira(
      [
        { customer_user_id: 'clone', omie_codigo_vendedor: 10 }, // vendedor=regina
        { customer_user_id: 'gemeo', omie_codigo_vendedor: 20 }, // vendedor=tati (≠)
      ],
      [
        { omie_codigo_vendedor: 10, user_id: 'regina' },
        { omie_codigo_vendedor: 20, user_id: 'tati' },
      ],
      HUNTER,
      new Map([['clone', 'gemeo']]),
    );
    // fail-closed SEGURO: cada membro vira cliente normal visível, nenhum escondido stale
    expect(find(r, 'clone')).toEqual({
      customer_user_id: 'clone', owner_user_id: 'regina', source: 'omie', omie_codigo_vendedor: 10, eligible: true,
    });
    expect(find(r, 'gemeo')).toEqual({
      customer_user_id: 'gemeo', owner_user_id: 'tati', source: 'omie', omie_codigo_vendedor: 20, eligible: true,
    });
    expect(r.conflicts).toEqual([
      { customer_user_id: 'gemeo', omie_codigo_vendedor: 10, candidate_user_ids: ['regina', 'tati'] },
    ]);
  });

  it('cadeia A→B→C (canônico que também é alias) → chainViolations não-vazio (caller deve abortar)', () => {
    const r = computeCarteira(
      [
        { customer_user_id: 'a', omie_codigo_vendedor: 10 },
        { customer_user_id: 'b', omie_codigo_vendedor: null },
        { customer_user_id: 'c', omie_codigo_vendedor: null },
      ],
      [{ omie_codigo_vendedor: 10, user_id: 'regina' }],
      HUNTER,
      new Map([['a', 'b'], ['b', 'c']]), // 'b' é canônico de 'a' MAS também é alias → cadeia
    );
    expect(r.chainViolations).toContain('a');
  });

  it('clone órfão (sem vendedor) + gêmeo órfão → canônico vira hunter; clone escondido no hunter', () => {
    const r = computeCarteira(
      [
        { customer_user_id: 'clone', omie_codigo_vendedor: null },
        { customer_user_id: 'gemeo', omie_codigo_vendedor: null },
      ],
      [],
      HUNTER,
      new Map([['clone', 'gemeo']]),
    );
    expect(find(r, 'gemeo')).toEqual({
      customer_user_id: 'gemeo', owner_user_id: HUNTER, source: 'hunter_orphan', omie_codigo_vendedor: null, eligible: true,
    });
    expect(find(r, 'clone')).toEqual({
      customer_user_id: 'clone', owner_user_id: HUNTER, source: 'hunter_orphan', omie_codigo_vendedor: null, eligible: false,
    });
  });
});
