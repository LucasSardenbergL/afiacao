import { describe, it, expect } from 'vitest';
import { parsePostgresFinanceiroError } from '../error-handler';

describe('parsePostgresFinanceiroError', () => {
  it('detects PERIOD_LOCKED (P0001)', () => {
    const err = {
      code: 'P0001',
      message: 'PERIOD_LOCKED: Período 03/2026 da empresa colacor está fechado em 2026-03-31. Use override de emergência.',
    };
    const parsed = parsePostgresFinanceiroError(err);
    expect(parsed.kind).toBe('period_locked');
    if (parsed.kind === 'period_locked') {
      expect(parsed.empresa).toBe('colacor');
      expect(parsed.periodo).toBe('03/2026');
    }
  });

  it('detects MAPPING_INCOMPLETE (P0002)', () => {
    const err = {
      code: 'P0002',
      message: 'MAPPING_INCOMPLETE: 3 categorias sem mapeamento DRE: [{"id":"123","nome":"Honorários"}]',
    };
    const parsed = parsePostgresFinanceiroError(err);
    expect(parsed.kind).toBe('mapping_incomplete');
    if (parsed.kind === 'mapping_incomplete') {
      expect(parsed.count).toBe(3);
      expect(parsed.pendentes).toEqual([{ id: '123', nome: 'Honorários' }]);
    }
  });

  it('returns kind=unknown for other errors', () => {
    const parsed = parsePostgresFinanceiroError({ code: '23505', message: 'duplicate key' });
    expect(parsed.kind).toBe('unknown');
  });

  it('handles null/undefined gracefully', () => {
    expect(parsePostgresFinanceiroError(null).kind).toBe('unknown');
    expect(parsePostgresFinanceiroError(undefined).kind).toBe('unknown');
  });
});
