import { describe, it, expect } from 'vitest';
import { sanitizeForPostgrestOr } from '@/lib/postgrest';

describe('sanitizeForPostgrestOr', () => {
  it('remove a vírgula (separador de filtros do .or())', () => {
    // Sem isso, o usuário injeta uma cláusula extra: `x,id.gt.0` viraria
    // dois predicados (ilike + id>0), alargando o resultado da query.
    expect(sanitizeForPostgrestOr('x,id.gt.0')).toBe('xid.gt.0');
  });

  it('remove parênteses (agrupamento de cláusulas)', () => {
    expect(sanitizeForPostgrestOr('a(b)c')).toBe('abc');
  });

  it('remove os wildcards do ILIKE (% e _)', () => {
    expect(sanitizeForPostgrestOr('50%_off')).toBe('50off');
  });

  it('remove barra invertida (escape do parser)', () => {
    expect(sanitizeForPostgrestOr('a\\b')).toBe('ab');
  });

  it('remove aspas duplas (delimitador de valor)', () => {
    expect(sanitizeForPostgrestOr('a"b"c')).toBe('abc');
  });

  it('remove todos os caracteres especiais combinados', () => {
    expect(sanitizeForPostgrestOr('%_,()\\"')).toBe('');
  });

  it('neutraliza um payload de injeção real mantendo só texto inerte', () => {
    expect(sanitizeForPostgrestOr('foo,role.eq.master')).toBe('foorole.eq.master');
  });

  it('preserva texto comum: letras, números, espaços, acentos, ponto e hífen', () => {
    expect(sanitizeForPostgrestOr('Tinta Azul-Céu 2.5L')).toBe('Tinta Azul-Céu 2.5L');
  });

  it('retorna string vazia para entrada vazia', () => {
    expect(sanitizeForPostgrestOr('')).toBe('');
  });

  it('é idempotente (aplicar duas vezes não muda o resultado)', () => {
    const once = sanitizeForPostgrestOr('a,b(c)%_\\"d');
    expect(sanitizeForPostgrestOr(once)).toBe(once);
  });
});
