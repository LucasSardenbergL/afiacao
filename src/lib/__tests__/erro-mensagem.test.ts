import { describe, it, expect } from 'vitest';
import { mensagemDeErro } from '../erro-mensagem';

/**
 * O idiom `err instanceof Error ? err.message : String(err)` falha no erro MAIS COMUM
 * desta camada: sem `.throwOnError()`, o `error` do supabase-js é um objeto PLANO
 * `{ message, details, hint, code }` (PostgrestBuilder.ts), não um `Error`. Um
 * `throw error` desses vira "[object Object]" no toast — a mensagem acionável do servidor
 * morre na fronteira, mesma classe do "non-2xx status code" que invoke-function resolve.
 */
describe('mensagemDeErro', () => {
  it('erro plano do PostgREST (o caso que virava "[object Object]")', () => {
    const postgrest = {
      message: 'Já existe plano tático gerado hoje para este cliente (dia operacional BRT)',
      details: '', hint: '', code: '23505',
    };
    expect(mensagemDeErro(postgrest)).toBe(
      'Já existe plano tático gerado hoje para este cliente (dia operacional BRT)',
    );
    // O discriminador: o idiom antigo produzia isto.
    expect(String(postgrest)).toBe('[object Object]');
  });

  it('Error de verdade continua funcionando', () => {
    expect(mensagemDeErro(new Error('Créditos da IA esgotados'))).toBe('Créditos da IA esgotados');
  });

  it('string crua é aceita', () => {
    expect(mensagemDeErro('falhou feio')).toBe('falhou feio');
  });

  it('sem mensagem utilizável devolve null — nunca "[object Object]"', () => {
    // Ausente ≠ mensagem fabricada: quem chama escolhe o fallback, e "[object Object]"
    // é ruído com cara de diagnóstico.
    expect(mensagemDeErro({})).toBeNull();
    expect(mensagemDeErro({ code: 'PGRST301' })).toBeNull();
    expect(mensagemDeErro({ message: '   ' })).toBeNull();
    expect(mensagemDeErro(null)).toBeNull();
    expect(mensagemDeErro(undefined)).toBeNull();
    expect(mensagemDeErro('')).toBeNull();
  });

  it('nunca devolve a string "[object Object]"', () => {
    for (const v of [{}, { message: 1 }, { message: {} }, [], new Map()]) {
      expect(mensagemDeErro(v)).not.toBe('[object Object]');
    }
  });
});
