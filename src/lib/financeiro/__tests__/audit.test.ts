import { describe, it, expect } from 'vitest';
import { formatAuditDiff, formatAuditOrigem, formatAuditValue } from '../audit';

describe('formatAuditDiff', () => {
  it('formats UPDATE diff into ordered list', () => {
    const result = formatAuditDiff('UPDATE', {
      valor_documento: { before: 100, after: 150 },
      status_titulo: { before: 'ABERTO', after: 'PAGO' },
    });
    expect(result).toHaveLength(2);
    // sort is alphabetical: status_titulo (s) < valor_documento (v)
    expect(result[0]).toMatchObject({ field: 'status_titulo', before: 'ABERTO', after: 'PAGO' });
  });

  it('formats INSERT as fields with after only', () => {
    const result = formatAuditDiff('INSERT', { id: 'abc', valor: 100 });
    expect(result.every(r => r.before === undefined)).toBe(true);
  });

  it('formats DELETE as fields with before only', () => {
    const result = formatAuditDiff('DELETE', { id: 'abc', valor: 100 });
    expect(result.every(r => r.after === undefined)).toBe(true);
  });
});

describe('formatAuditOrigem', () => {
  it('maps origem to user-facing label', () => {
    expect(formatAuditOrigem('omie_sync')).toBe('Sync Omie');
    expect(formatAuditOrigem('override_emergencia')).toBe('Override emergência');
    expect(formatAuditOrigem('manual')).toBe('Manual');
  });
});

describe('formatAuditValue', () => {
  it('formats numeric BRL', () => {
    const formatted = formatAuditValue(1234.5);
    // Intl may use non-breaking space between R$ and number depending on ICU version
    expect(formatted.replace(/\u00A0/g, ' ')).toBe('R$ 1.234,50');
  });
  it('formats null as em-dash', () => {
    expect(formatAuditValue(null)).toBe('—');
  });
  it('returns iso date as is', () => {
    expect(formatAuditValue('2026-05-17')).toBe('2026-05-17');
  });
});
