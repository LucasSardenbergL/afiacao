import { describe, expect, it } from 'vitest';
import { formatarBRLCompacto } from '../ceo-formato';

describe('formatarBRLCompacto', () => {
  it('ausente vira travessão, não R$ 0', () => {
    expect(formatarBRLCompacto(null)).toBe('—');
    expect(formatarBRLCompacto(undefined)).toBe('—');
  });

  it('formata em ordem de grandeza', () => {
    expect(formatarBRLCompacto(1_234_567)).toMatch(/1,2\s*mi/);
  });
});
