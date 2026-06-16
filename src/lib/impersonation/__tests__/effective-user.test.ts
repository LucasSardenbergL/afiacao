import { describe, it, expect } from 'vitest';
import { resolveEffectiveUserId } from '../effective-user';

describe('resolveEffectiveUserId', () => {
  it('retorna o id do master quando não há alvo', () => {
    expect(resolveEffectiveUserId('master-1', null)).toBe('master-1');
  });
  it('retorna o id do alvo quando impersonando', () => {
    expect(resolveEffectiveUserId('master-1', { id: 'regina-9', nome: 'Regina', grupo: 'farmer' })).toBe('regina-9');
  });
  it('cai pro master se realId é null e não há alvo', () => {
    expect(resolveEffectiveUserId(null, null)).toBeNull();
  });
});
