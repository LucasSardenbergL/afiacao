import { describe, it, expect } from 'vitest';
import { deriveSalesHistoryStatus, clampActiveDays } from '../salesHistoryStatus';

describe('clampActiveDays', () => {
  it('NaN/null/undefined → 180 (default)', () => {
    expect(clampActiveDays(NaN)).toBe(180);
    expect(clampActiveDays(null)).toBe(180);
    expect(clampActiveDays(undefined)).toBe(180);
  });
  it('abaixo do piso → 30; acima do teto → 999; fração → round', () => {
    expect(clampActiveDays(10)).toBe(30);
    expect(clampActiveDays(5000)).toBe(999);
    expect(clampActiveDays(90.4)).toBe(90);
  });
});

describe('deriveSalesHistoryStatus (degradação honesta — ausente≠zero)', () => {
  it('ausente (undefined/null) → sem_historico', () => {
    expect(deriveSalesHistoryStatus(undefined)).toBe('sem_historico');
    expect(deriveSalesHistoryStatus(null)).toBe('sem_historico');
  });
  it('revenue 0 ou negativo → sem_historico (sem venda válida, NÃO "nunca comprou")', () => {
    expect(deriveSalesHistoryStatus({ total_revenue: 0, days_since_last_purchase: 5 })).toBe('sem_historico');
    expect(deriveSalesHistoryStatus({ total_revenue: -10, days_since_last_purchase: 5 })).toBe('sem_historico');
  });
  it('revenue>0 e days ≤ cap → ativo', () => {
    expect(deriveSalesHistoryStatus({ total_revenue: 100, days_since_last_purchase: 180 })).toBe('ativo');
    expect(deriveSalesHistoryStatus({ total_revenue: 100, days_since_last_purchase: 0 })).toBe('ativo');
  });
  it('revenue>0 e days > cap → stale', () => {
    expect(deriveSalesHistoryStatus({ total_revenue: 100, days_since_last_purchase: 181 })).toBe('stale');
  });
  it('ANÔMALO: revenue>0 e days null → stale explícito (não comparação falsa)', () => {
    expect(deriveSalesHistoryStatus({ total_revenue: 100, days_since_last_purchase: null })).toBe('stale');
  });
  it('numeric-string do PG → coage (revenue e days)', () => {
    expect(deriveSalesHistoryStatus({ total_revenue: ('900' as unknown as number), days_since_last_purchase: ('12' as unknown as number) })).toBe('ativo');
  });
  it('NaN em revenue → sem_historico (Number.isFinite guard)', () => {
    expect(deriveSalesHistoryStatus({ total_revenue: Number('xx'), days_since_last_purchase: 5 })).toBe('sem_historico');
  });
  it('cap custom: days=120 com cap 90 → stale; com cap 180 → ativo', () => {
    expect(deriveSalesHistoryStatus({ total_revenue: 100, days_since_last_purchase: 120 }, 90)).toBe('stale');
    expect(deriveSalesHistoryStatus({ total_revenue: 100, days_since_last_purchase: 120 }, 180)).toBe('ativo');
  });
});
