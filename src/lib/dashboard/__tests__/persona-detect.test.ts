import { describe, it, expect } from 'vitest';
import { inferPersona, type PersonaSignals } from '../persona-detect';

const baseSignals: PersonaSignals = {
  override: null,
  role: 'employee',
  commercialRole: null,
  isSalesOnly: false,
  routeCounts: {},
};

describe('inferPersona', () => {
  it('override always wins', () => {
    const r = inferPersona({ ...baseSignals, override: 'financeiro', role: 'master', commercialRole: 'super_admin' });
    expect(r.persona).toBe('financeiro');
    expect(r.source).toBe('manual');
  });

  it('salesOnly CPF → vendedor (beats commercial_role)', () => {
    const r = inferPersona({ ...baseSignals, isSalesOnly: true, commercialRole: 'gerencial' });
    expect(r.persona).toBe('vendedor');
    expect(r.source).toBe('sales_only');
  });

  it('commercial_role operacional → vendedor', () => {
    const r = inferPersona({ ...baseSignals, commercialRole: 'operacional' });
    expect(r.persona).toBe('vendedor');
    expect(r.source).toBe('commercial_role');
  });

  it('commercial_role gerencial → gestor', () => {
    const r = inferPersona({ ...baseSignals, commercialRole: 'gerencial' });
    expect(r.persona).toBe('gestor');
    expect(r.source).toBe('commercial_role');
  });

  it('commercial_role estrategico → master', () => {
    const r = inferPersona({ ...baseSignals, commercialRole: 'estrategico' });
    expect(r.persona).toBe('master');
    expect(r.source).toBe('commercial_role');
  });

  it('commercial_role super_admin → master', () => {
    const r = inferPersona({ ...baseSignals, commercialRole: 'super_admin' });
    expect(r.persona).toBe('master');
    expect(r.source).toBe('commercial_role');
  });

  it('heuristic: 50% reposicao → comprador', () => {
    const r = inferPersona({
      ...baseSignals,
      routeCounts: {
        '/admin/reposicao': { count: 60, lastSeenIso: new Date().toISOString() },
        '/financeiro':     { count: 40, lastSeenIso: new Date().toISOString() },
      },
    });
    expect(r.persona).toBe('comprador');
    expect(r.source).toBe('inference');
  });

  it('heuristic: 50% estoque + recebimento → estoque', () => {
    const r = inferPersona({
      ...baseSignals,
      routeCounts: {
        '/admin/estoque': { count: 30, lastSeenIso: new Date().toISOString() },
        '/recebimento':   { count: 25, lastSeenIso: new Date().toISOString() },
        '/sales':         { count: 45, lastSeenIso: new Date().toISOString() },
      },
    });
    expect(r.persona).toBe('estoque');
    expect(r.source).toBe('inference');
  });

  it('not enough visits → default (master if master role)', () => {
    const r = inferPersona({
      ...baseSignals,
      role: 'master',
      routeCounts: {
        '/admin/reposicao': { count: 5, lastSeenIso: new Date().toISOString() },
      },
    });
    expect(r.persona).toBe('master');
    expect(r.source).toBe('default');
  });

  it('not enough visits + no role → geral', () => {
    const r = inferPersona({
      ...baseSignals,
      role: 'employee',
    });
    expect(r.persona).toBe('geral');
    expect(r.source).toBe('default');
  });

  it('below 40% threshold → default even with enough visits', () => {
    const r = inferPersona({
      ...baseSignals,
      role: 'employee',
      routeCounts: {
        '/admin/reposicao': { count: 4, lastSeenIso: new Date().toISOString() },
        '/financeiro':      { count: 4, lastSeenIso: new Date().toISOString() },
        '/admin/estoque':   { count: 4, lastSeenIso: new Date().toISOString() },
      },
    });
    expect(r.persona).toBe('geral');
    expect(r.source).toBe('default');
  });
});
