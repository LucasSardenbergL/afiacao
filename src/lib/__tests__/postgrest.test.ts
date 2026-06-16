import { describe, it, expect } from 'vitest';
import {
  sanitizeForPostgrestOr,
  ilike,
  ilikeOr,
  eqInt,
  eqText,
  orFilter,
} from '../postgrest';

// Os metacaracteres que o parser do .or() interpreta — nenhum pode sobreviver à sanitização.
const META = ['%', '_', ',', '(', ')', '\\', '"'];

describe('sanitizeForPostgrestOr', () => {
  it('texto limpo passa inalterado (espaço, dígito, acento, hífen, ponto sobrevivem)', () => {
    expect(sanitizeForPostgrestOr('abrasivo 120')).toBe('abrasivo 120');
    expect(sanitizeForPostgrestOr('ção-1.5')).toBe('ção-1.5');
  });

  it('remove cada metacaractere do parser', () => {
    expect(sanitizeForPostgrestOr('a%b')).toBe('ab');
    expect(sanitizeForPostgrestOr('a_b')).toBe('ab');
    expect(sanitizeForPostgrestOr('a,b')).toBe('ab');
    expect(sanitizeForPostgrestOr('a(b)c')).toBe('abc');
    expect(sanitizeForPostgrestOr('a\\b')).toBe('ab');
    expect(sanitizeForPostgrestOr('a"b')).toBe('ab');
  });

  it('neutraliza o vetor de injeção (vírgula+paren somem → vira termo literal)', () => {
    expect(sanitizeForPostgrestOr('%,id.gt.0,(')).toBe('id.gt.0');
  });

  it('propriedade de segurança: NENHUM metacaractere sobra, qualquer que seja a entrada', () => {
    const sujo = 'x,id.gt.0,(nome.ilike.%a%),"\\_';
    const limpo = sanitizeForPostgrestOr(sujo);
    for (const ch of META) expect(limpo.includes(ch)).toBe(false);
  });

  it('string vazia → string vazia', () => {
    expect(sanitizeForPostgrestOr('')).toBe('');
  });
});

describe('ilike', () => {
  it('monta col.ilike.%termo%', () => {
    expect(ilike('nome', 'abc')).toBe('nome.ilike.%abc%');
  });

  it('sanitiza o termo sem quebrar a estrutura', () => {
    expect(ilike('nome', 'a,b')).toBe('nome.ilike.%ab%');
  });
});

describe('ilikeOr', () => {
  it('N colunas, 1 termo → N cláusulas separadas por vírgula', () => {
    expect(ilikeOr(['nome', 'codigo'], 'abc')).toBe('nome.ilike.%abc%,codigo.ilike.%abc%');
  });

  it('termo malicioso NÃO injeta cláusula extra (nº de vírgulas = colunas - 1)', () => {
    const cols = ['nome', 'codigo'];
    const out = ilikeOr(cols, 'x,id.gt.0,(');
    expect((out.match(/,/g) || []).length).toBe(cols.length - 1);
    expect(out).toBe('nome.ilike.%xid.gt.0%,codigo.ilike.%xid.gt.0%');
  });

  it('lista de colunas vazia → string vazia', () => {
    expect(ilikeOr([], 'abc')).toBe('');
  });
});

describe('eqInt', () => {
  it('só dígitos → usa o número', () => {
    expect(eqInt('id', '42')).toBe('id.eq.42');
  });

  it('faz trim antes de validar', () => {
    expect(eqInt('id', '  42  ')).toBe('id.eq.42');
  });

  it('mantém zeros à esquerda (não converte pra Number)', () => {
    expect(eqInt('id', '007')).toBe('id.eq.007');
  });

  it('não-dígito / decimal / injeção / vazio → eq.0 (não casa nada)', () => {
    expect(eqInt('id', 'abc')).toBe('id.eq.0');
    expect(eqInt('id', '4.5')).toBe('id.eq.0');
    expect(eqInt('id', '1; DROP TABLE x')).toBe('id.eq.0');
    expect(eqInt('id', '')).toBe('id.eq.0');
    expect(eqInt('id', '-3')).toBe('id.eq.0');
  });
});

describe('eqText', () => {
  it('valor limpo → col.eq.valor', () => {
    expect(eqText('status', 'ativo')).toBe('status.eq.ativo');
  });

  it('sanitiza o valor', () => {
    expect(eqText('status', 'a,b)')).toBe('status.eq.ab');
  });
});

describe('orFilter', () => {
  it('junta cláusulas com vírgula', () => {
    expect(orFilter('a.eq.1', 'b.ilike.%x%')).toBe('a.eq.1,b.ilike.%x%');
  });

  it('uma cláusula → ela mesma', () => {
    expect(orFilter('a.eq.1')).toBe('a.eq.1');
  });

  it('zero cláusulas → string vazia', () => {
    expect(orFilter()).toBe('');
  });
});
