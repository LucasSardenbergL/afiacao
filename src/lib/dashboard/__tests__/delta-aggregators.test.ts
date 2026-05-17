import { describe, it, expect } from 'vitest';
import { formatTimeSince, formatDeltaBullet, shouldHideStrip } from '../delta-aggregators';

describe('formatTimeSince', () => {
  it('renders minutes', () => {
    expect(formatTimeSince(0)).toBe('há instantes');
    expect(formatTimeSince(1)).toBe('há 1min');
    expect(formatTimeSince(45)).toBe('há 45min');
  });
  it('renders hours', () => {
    expect(formatTimeSince(60)).toBe('há 1h');
    expect(formatTimeSince(125)).toBe('há 2h 5min');
    expect(formatTimeSince(180)).toBe('há 3h');
  });
  it('renders days', () => {
    expect(formatTimeSince(60 * 24)).toBe('há 1d');
    expect(formatTimeSince(60 * 24 * 3 + 60 * 5)).toBe('há 3d');
  });
});

describe('formatDeltaBullet', () => {
  it('positive count', () => {
    expect(formatDeltaBullet({ label: 'pedidos', value: 12 })).toBe('+12 pedidos');
  });
  it('singular', () => {
    expect(formatDeltaBullet({ label: 'NF chegou', value: 1, singular: 'NF chegou' })).toBe('+1 NF chegou');
  });
  it('value 0 returns null (excluded from strip)', () => {
    expect(formatDeltaBullet({ label: 'pedidos', value: 0 })).toBeNull();
  });
  it('formatted currency', () => {
    expect(formatDeltaBullet({ label: 'faturados', value: 47000, format: 'currency' })).toBe('+R$ 47k faturados');
  });
});

describe('shouldHideStrip', () => {
  it('hides when last visit < 30min', () => {
    expect(shouldHideStrip(29)).toBe(true);
    expect(shouldHideStrip(0)).toBe(true);
  });
  it('shows when >= 30min', () => {
    expect(shouldHideStrip(30)).toBe(false);
    expect(shouldHideStrip(120)).toBe(false);
  });
  it('shows when null (first visit)', () => {
    expect(shouldHideStrip(null)).toBe(false);
  });
});
