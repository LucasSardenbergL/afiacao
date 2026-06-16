import { describe, it, expect } from 'vitest';
import { badgeLevel, rollupDomain, formatAge, isHealthy, shouldShowDiagnostics } from '../health-helpers';
import type { DataHealthCheck } from '../types';

const mk = (over: Partial<DataHealthCheck>): DataHealthCheck => ({
  source: 's', domain: 'financeiro', status: 'ok', age_seconds: 0,
  expected_max_age_seconds: 3600, freshness_basis: 'max_updated_at',
  message: '', last_error: null, probable_cause: null, how_to_fix: null,
  severity: 'info', ...over,
});

describe('badgeLevel', () => {
  it('verde quando todos ok', () => {
    expect(badgeLevel([mk({ status: 'ok' }), mk({ status: 'ok' })])).toBe('green');
  });
  it('vermelho quando algum broken', () => {
    expect(badgeLevel([mk({ status: 'ok' }), mk({ status: 'broken' })])).toBe('red');
  });
  it('amarelo quando algum stale (e nenhum broken)', () => {
    expect(badgeLevel([mk({ status: 'ok' }), mk({ status: 'stale' })])).toBe('amber');
  });
  it('SEM VERDE SILENCIOSO: lista vazia => vermelho (não consegue provar saúde)', () => {
    expect(badgeLevel([])).toBe('red');
  });
  it('SEM VERDE SILENCIOSO: unknown => vermelho', () => {
    expect(badgeLevel([mk({ status: 'unknown' })])).toBe('red');
  });
});

describe('rollupDomain', () => {
  it('agrupa pegando o pior status do domínio', () => {
    const checks = [
      mk({ domain: 'financeiro', source: 'cp', status: 'ok' }),
      mk({ domain: 'financeiro', source: 'cr', status: 'stale' }),
      mk({ domain: 'carteira', source: 'scores', status: 'ok' }),
    ];
    const r = rollupDomain(checks);
    expect(r.find(d => d.domain === 'financeiro')?.status).toBe('stale');
    expect(r.find(d => d.domain === 'carteira')?.status).toBe('ok');
  });
});

describe('formatAge', () => {
  it('null => "desconhecido"', () => { expect(formatAge(null)).toBe('desconhecido'); });
  it('segundos => "há X min"', () => { expect(formatAge(120)).toBe('há 2 min'); });
  it('horas', () => { expect(formatAge(7200)).toBe('há 2 h'); });
  it('dias', () => { expect(formatAge(172800)).toBe('há 2 dias'); });
});

describe('isHealthy', () => {
  it('só ok', () => { expect(isHealthy([mk({ status: 'ok' })])).toBe(true); });
  it('stale não é healthy', () => { expect(isHealthy([mk({ status: 'stale' })])).toBe(false); });
});

describe('shouldShowDiagnostics', () => {
  it('check ok NÃO exibe diagnóstico (esconde erro transitório já recuperado)', () => {
    expect(shouldShowDiagnostics(mk({ status: 'ok', last_error: 'orphaned_running_timeout' }))).toBe(false);
  });
  it('stale exibe diagnóstico', () => {
    expect(shouldShowDiagnostics(mk({ status: 'stale' }))).toBe(true);
  });
  it('broken exibe diagnóstico', () => {
    expect(shouldShowDiagnostics(mk({ status: 'broken' }))).toBe(true);
  });
  it('unknown exibe diagnóstico', () => {
    expect(shouldShowDiagnostics(mk({ status: 'unknown' }))).toBe(true);
  });
});
