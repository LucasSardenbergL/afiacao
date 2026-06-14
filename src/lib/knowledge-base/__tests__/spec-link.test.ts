import { describe, it, expect } from 'vitest';
import { keyDeSku } from '../spec-link';

describe('keyDeSku', () => {
  it('lowercase do account + cod', () => {
    expect(keyDeSku('OBEN', 123)).toBe('oben|123');
    expect(keyDeSku('oben', 123)).toBe('oben|123');
  });
  it('account nulo/undefined vira vazio', () => {
    expect(keyDeSku(undefined, 5)).toBe('|5');
    expect(keyDeSku(null as unknown as string, 5)).toBe('|5');
  });
});
