import { describe, it, expect } from 'vitest';
import {
  sanitizeForPostgrestOr,
  ilike,
  ilikeOr,
  eqInt,
  eqText,
  orFilter,
} from '@/lib/postgrest';

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

describe('ilike', () => {
  it('monta cláusula ilike sanitizada', () => {
    expect(ilike('nome', 'azul')).toBe('nome.ilike.%azul%');
  });

  it('strippa metacaracteres do termo', () => {
    expect(ilike('nome', 'x,id.gt.0')).toBe('nome.ilike.%xid.gt.0%');
  });
});

describe('ilikeOr', () => {
  it('aplica o mesmo termo sanitizado a várias colunas', () => {
    expect(ilikeOr(['name', 'email'], 'foo')).toBe('name.ilike.%foo%,email.ilike.%foo%');
  });

  it('injeção via vírgula não escapa do predicado', () => {
    expect(ilikeOr(['name'], 'x,role.eq.master')).toBe('name.ilike.%xrole.eq.master%');
  });
});

describe('eqInt', () => {
  it('mantém termo só-dígitos', () => {
    expect(eqInt('codigo', '123')).toBe('codigo.eq.123');
  });

  it('vira 0 quando não é só dígitos (texto, float, vazio)', () => {
    expect(eqInt('codigo', 'abc')).toBe('codigo.eq.0');
    expect(eqInt('codigo', '12.5')).toBe('codigo.eq.0');
    expect(eqInt('codigo', '')).toBe('codigo.eq.0');
  });

  it('não permite injeção via valor numérico forjado', () => {
    expect(eqInt('codigo', '1,role.eq.master')).toBe('codigo.eq.0');
  });
});

describe('eqText', () => {
  it('match exato sanitizado preservando máscara de documento', () => {
    expect(eqText('document', '12.345.678/0001-90')).toBe('document.eq.12.345.678/0001-90');
  });

  it('strippa metacaracteres de injeção', () => {
    expect(eqText('document', 'x),y')).toBe('document.eq.xy');
  });
});

describe('orFilter', () => {
  it('junta cláusulas com vírgula', () => {
    expect(orFilter(eqInt('codigo', '7'), ilike('descricao', 'tinta'))).toBe(
      'codigo.eq.7,descricao.ilike.%tinta%',
    );
  });
});
