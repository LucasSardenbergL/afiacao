import { describe, it, expect } from 'vitest';
import { deriveSalesBase } from '../salesBase';

describe('deriveSalesBase (recência-viva — degradação honesta)', () => {
  it('ausente (undefined) → 999/0/0 (sem venda = "morto", não "comprou hoje")', () => {
    expect(deriveSalesBase(undefined)).toEqual({
      days_since_last_purchase: 999,
      avg_monthly_spend_180d: 0,
      category_count: 0,
    });
  });

  it('ausente (null) → 999/0/0', () => {
    expect(deriveSalesBase(null)).toEqual({
      days_since_last_purchase: 999,
      avg_monthly_spend_180d: 0,
      category_count: 0,
    });
  });

  it('valores reais: days direto, spend = round(revenue_180d/6), category direto', () => {
    expect(deriveSalesBase({ days_since_last_purchase: 12, revenue_180d: 600, category_count: 3 })).toEqual({
      days_since_last_purchase: 12,
      avg_monthly_spend_180d: 100, // 600/6
      category_count: 3,
    });
  });

  it('comprou hoje legítimo: days=0 preservado (NÃO vira 999)', () => {
    expect(deriveSalesBase({ days_since_last_purchase: 0, revenue_180d: 1200, category_count: 2 }).days_since_last_purchase).toBe(0);
  });

  it('campos null na linha → 999/0/0 (?? defaults)', () => {
    expect(deriveSalesBase({ days_since_last_purchase: null, revenue_180d: null, category_count: null })).toEqual({
      days_since_last_purchase: 999,
      avg_monthly_spend_180d: 0,
      category_count: 0,
    });
  });

  it('NaN (numeric corrompido) → guarda em 999/0/0 (Number.isFinite)', () => {
    const nan = Number('xx'); // NaN
    expect(deriveSalesBase({ days_since_last_purchase: nan, revenue_180d: nan, category_count: nan })).toEqual({
      days_since_last_purchase: 999,
      avg_monthly_spend_180d: 0,
      category_count: 0,
    });
  });

  it('revenue numeric-string (como vem do PG) → parseado', () => {
    // o driver entrega numeric como string; Number() coage
    expect(deriveSalesBase({ days_since_last_purchase: 5, revenue_180d: ('900' as unknown as number), category_count: ('4' as unknown as number) })).toEqual({
      days_since_last_purchase: 5,
      avg_monthly_spend_180d: 150, // 900/6
      category_count: 4,
    });
  });

  it('spend arredonda (round, não trunca)', () => {
    // 100/6 = 16.66… → 17
    expect(deriveSalesBase({ days_since_last_purchase: 1, revenue_180d: 100, category_count: 1 }).avg_monthly_spend_180d).toBe(17);
  });
});
