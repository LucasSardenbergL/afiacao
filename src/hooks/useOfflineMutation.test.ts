import { describe, it, expect } from 'vitest';
import { isNetworkError } from './useOfflineMutation';

describe('isNetworkError', () => {
  it('TypeError de rede → true', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
  });
  it('Error com mensagem de rede → true', () => {
    expect(isNetworkError(new Error('NetworkError when attempting to fetch resource'))).toBe(true);
  });
  it('objeto plain do supabase ({message}) com falha de fetch → true (caminho .rpc())', () => {
    expect(isNetworkError({ message: 'TypeError: Failed to fetch' })).toBe(true);
    expect(isNetworkError({ message: 'Network request failed' })).toBe(true);
  });
  it('erro de aplicação (permission denied / not-null) → false', () => {
    expect(isNetworkError({ message: 'permission denied for function confirmar_item_picking' })).toBe(false);
    expect(isNetworkError(new Error('null value in column violates not-null constraint'))).toBe(false);
  });
  it('null/undefined/objeto sem message → false', () => {
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
    expect(isNetworkError({ code: '23505' })).toBe(false);
  });
});
