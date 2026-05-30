import { describe, it, expect, beforeEach } from 'vitest';
import { incrementRouteVisit, getRouteCounts, clearRouteCounts, classifyPath } from '../route-tracker';

describe('classifyPath', () => {
  it('classifies known prefixes', () => {
    expect(classifyPath('/admin/reposicao/sessao')).toBe('/admin/reposicao');
    expect(classifyPath('/admin/reposicao/sessao/pedidos')).toBe('/admin/reposicao');
    expect(classifyPath('/financeiro/cockpit')).toBe('/financeiro');
    expect(classifyPath('/admin/estoque/picking')).toBe('/admin/estoque');
    expect(classifyPath('/recebimento')).toBe('/recebimento');
    expect(classifyPath('/tintometrico/catalogo')).toBe('/tintometrico');
    expect(classifyPath('/sales/new')).toBe('/sales');
  });

  it('returns null for unknown paths', () => {
    expect(classifyPath('/profile')).toBeNull();
    expect(classifyPath('/')).toBeNull();
  });
});

describe('route counts storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts empty', () => {
    expect(getRouteCounts()).toEqual({});
  });

  it('increments visit and stores timestamp', () => {
    const before = Date.now();
    incrementRouteVisit('/admin/reposicao');
    incrementRouteVisit('/admin/reposicao');
    incrementRouteVisit('/financeiro');
    const counts = getRouteCounts();
    expect(counts['/admin/reposicao'].count).toBe(2);
    expect(counts['/financeiro'].count).toBe(1);
    expect(counts['/admin/reposicao'].lastSeenIso).toBeDefined();
    expect(new Date(counts['/admin/reposicao'].lastSeenIso).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('expires entries older than 30 days', () => {
    const expiredIso = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    localStorage.setItem(
      'dashboardRouteCounts',
      JSON.stringify({
        '/financeiro': { count: 5, lastSeenIso: expiredIso },
        '/admin/estoque': { count: 3, lastSeenIso: new Date().toISOString() },
      }),
    );
    incrementRouteVisit('/admin/estoque');
    const counts = getRouteCounts();
    expect(counts['/financeiro']).toBeUndefined();
    expect(counts['/admin/estoque'].count).toBe(4);
  });

  it('clearRouteCounts removes all entries', () => {
    incrementRouteVisit('/admin/reposicao');
    clearRouteCounts();
    expect(getRouteCounts()).toEqual({});
  });

  it('ignores unknown paths in increment', () => {
    incrementRouteVisit('/profile');
    expect(getRouteCounts()).toEqual({});
  });
});
