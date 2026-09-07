/**
 * @vitest-environment jsdom
 *
 * Exceção ao particionamento por extensão (`projects` em vitest.config.ts): `.ts`, logo `node`
 * por padrão, mas o caminho sob teste é de BROWSER. Não foi o grep que provou — foi o vermelho:
 * o docblock entrou porque o teste falhou em `node`, que é a única prova que vale aqui.
 *
 * `isNetworkError` lê `navigator.onLine`; em node ele é `undefined`, então `!undefined` faz
 * TODO erro virar "erro de rede" e as asserções negativas caem. Em browser sempre há valor.
 */
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
