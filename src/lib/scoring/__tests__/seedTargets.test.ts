import { describe, it, expect } from 'vitest';
import { computeSeedTargets } from '../seedTargets';

type Row = { user_id: string; omie_codigo_vendedor?: string | null };
const ids = (rows: Row[]) => rows.map((r) => r.user_id).sort();

describe('computeSeedTargets (F1 — seed completa faltantes)', () => {
  it('inclui só clientes elegíveis SEM linha e SEM flag', () => {
    const eligible: Row[] = [
      { user_id: 'a' }, // novo → entra
      { user_id: 'b' }, // já tem linha → fora
      { user_id: 'c' }, // flaggeds → fora
      { user_id: 'd' }, // novo → entra
    ];
    const existing = new Set(['b']);
    const flagged = new Set(['c']);
    expect(ids(computeSeedTargets(eligible, existing, flagged))).toEqual(['a', 'd']);
  });

  it('NUNCA semeia fornecedor flaggeds (anti-ressurreição), mesmo se ausente da fcs', () => {
    const eligible: Row[] = [{ user_id: 'forn' }];
    const out = computeSeedTargets(eligible, new Set<string>(), new Set(['forn']));
    expect(out).toHaveLength(0);
  });

  it('NUNCA re-semeia quem já tem linha (seed só cria o que falta)', () => {
    const eligible: Row[] = [{ user_id: 'x' }, { user_id: 'y' }];
    const out = computeSeedTargets(eligible, new Set(['x', 'y']), new Set<string>());
    expect(out).toHaveLength(0);
  });

  it('steady-state: 0 faltantes → vazio (não dispara seed à toa)', () => {
    const eligible: Row[] = [{ user_id: 'x' }, { user_id: 'y' }];
    expect(computeSeedTargets(eligible, new Set(['x', 'y']), new Set<string>())).toEqual([]);
  });

  it('reset total: tabela vazia → semeia todos os elegíveis não-flaggeds', () => {
    const eligible: Row[] = [{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'c' }];
    const out = computeSeedTargets(eligible, new Set<string>(), new Set(['b']));
    expect(ids(out)).toEqual(['a', 'c']);
  });

  it('reset parcial (1 linha esparsa do recalc já existe) → semeia o RESTO', () => {
    // o cenário-mãe do F1: o recalc criou a linha de "a" antes do seed.
    const eligible: Row[] = [{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'c' }];
    const out = computeSeedTargets(eligible, new Set(['a']), new Set<string>());
    expect(ids(out)).toEqual(['b', 'c']);
  });

  it('deduplica user_id repetido em omie_clientes', () => {
    const eligible: Row[] = [{ user_id: 'a' }, { user_id: 'a' }, { user_id: 'b' }];
    expect(ids(computeSeedTargets(eligible, new Set<string>(), new Set<string>()))).toEqual(['a', 'b']);
  });

  it('ignora linha sem user_id (não cria score órfão)', () => {
    const eligible: Row[] = [{ user_id: '' }, { user_id: 'a' }];
    expect(ids(computeSeedTargets(eligible, new Set<string>(), new Set<string>()))).toEqual(['a']);
  });

  it('preserva o objeto de entrada (carrega omie_codigo_vendedor p/ o mapeamento do seed)', () => {
    const eligible: Row[] = [{ user_id: 'a', omie_codigo_vendedor: 'V1' }];
    const out = computeSeedTargets(eligible, new Set<string>(), new Set<string>());
    expect(out[0]).toEqual({ user_id: 'a', omie_codigo_vendedor: 'V1' });
  });

  it('inputs vazios → vazio', () => {
    expect(computeSeedTargets([], new Set<string>(), new Set<string>())).toEqual([]);
  });
});
