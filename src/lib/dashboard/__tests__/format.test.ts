import { describe, it, expect } from 'vitest';
import { formatCount, formatImportStatus } from '../format';

describe('formatCount', () => {
  it('renders small counts raw', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(7)).toBe('7');
    expect(formatCount(999)).toBe('999');
  });

  it('renders 4-digit counts with pt-BR separator', () => {
    expect(formatCount(1000)).toBe('1.000');
    expect(formatCount(5273)).toBe('5.273');
    expect(formatCount(9999)).toBe('9.999');
  });

  it('renders 5-6 digit counts compact "k"', () => {
    expect(formatCount(10_000)).toBe('10k');
    expect(formatCount(481_721)).toBe('482k');
    expect(formatCount(999_999)).toBe('1000k');
  });

  it('renders 7+ digit counts compact "M"', () => {
    expect(formatCount(1_000_000)).toBe('1,0M');
    expect(formatCount(1_234_567)).toBe('1,2M');
  });

  it('handles non-finite gracefully', () => {
    expect(formatCount(Number.NaN)).toBe('—');
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatImportStatus', () => {
  it('maps known statuses to short labels', () => {
    expect(formatImportStatus('processado')).toBe('ok');
    expect(formatImportStatus('concluido')).toBe('ok');
    expect(formatImportStatus('processando')).toBe('em curso');
    expect(formatImportStatus('erro')).toBe('erro');
    expect(formatImportStatus('parcial')).toBe('parcial');
  });

  it('returns em-dash for null/undefined/empty', () => {
    expect(formatImportStatus(null)).toBe('—');
    expect(formatImportStatus(undefined)).toBe('—');
    expect(formatImportStatus('')).toBe('—');
  });

  it('truncates unknown long statuses with ellipsis', () => {
    expect(formatImportStatus('algumarararara')).toBe('algumarar…');
    expect(formatImportStatus('curto')).toBe('curto');
  });
});
