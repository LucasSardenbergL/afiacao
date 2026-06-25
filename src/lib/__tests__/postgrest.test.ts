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
// (vírgula = separa cláusulas; () = agrupa; \ = escape; " = delimita valor; % _ = wildcards do ILIKE;
//  * = alias de % que o PostgREST aceita em like/ilike, pra evitar URL-encoding do %)
const META = ['%', '_', ',', '(', ')', '\\', '"', '*'];

describe('sanitizeForPostgrestOr', () => {
  it('texto limpo passa inalterado (espaço, dígito, acento, hífen, ponto sobrevivem)', () => {
    expect(sanitizeForPostgrestOr('abrasivo 120')).toBe('abrasivo 120');
    expect(sanitizeForPostgrestOr('ção-1.5')).toBe('ção-1.5');
    // nome de produto real do catálogo — a denylist preserva acento, hífen e ponto
    expect(sanitizeForPostgrestOr('Tinta Azul-Céu 2.5L')).toBe('Tinta Azul-Céu 2.5L');
  });

  it('remove cada metacaractere do parser', () => {
    expect(sanitizeForPostgrestOr('a%b')).toBe('ab');
    expect(sanitizeForPostgrestOr('a_b')).toBe('ab');
    expect(sanitizeForPostgrestOr('a,b')).toBe('ab');
    expect(sanitizeForPostgrestOr('a(b)c')).toBe('abc');
    expect(sanitizeForPostgrestOr('a\\b')).toBe('ab');
    expect(sanitizeForPostgrestOr('a"b')).toBe('ab');
  });

  it('remove o asterisco — PostgREST trata * como alias de % em like/ilike', () => {
    // postgrest.org (tables_views): "to avoid URL encoding you can use * as an alias
    // of the percent sign %". Logo `a*b` viraria o padrão `%a%b%` no ILIKE — wildcard
    // injection que o bloqueio de % e _ sozinho NÃO cobre (#1051).
    expect(sanitizeForPostgrestOr('a*b')).toBe('ab');
  });

  it('todos os metacaracteres juntos colapsam para vazio', () => {
    expect(sanitizeForPostgrestOr(META.join(''))).toBe(''); // '%_,()\\"*' → ''
  });

  it('neutraliza o vetor de injeção (vírgula+paren somem → vira termo literal)', () => {
    expect(sanitizeForPostgrestOr('%,id.gt.0,(')).toBe('id.gt.0');
    expect(sanitizeForPostgrestOr('foo,role.eq.master')).toBe('foorole.eq.master');
  });

  it('string vazia → string vazia', () => {
    expect(sanitizeForPostgrestOr('')).toBe('');
  });

  it('é idempotente (aplicar duas vezes não muda o resultado)', () => {
    const once = sanitizeForPostgrestOr('a,b(c)%_\\"*d');
    expect(sanitizeForPostgrestOr(once)).toBe(once);
  });

  // Propriedade de segurança central: NENHUM metacaractere pode sobreviver, em NENHUMA posição.
  // Varredura determinística de cada metacaractere isolado e cravado em texto benigno (início/meio/fim) —
  // não depende mais de um único payload escolhido a dedo (o ponto cego do teste antigo). Como itera META,
  // ganha o `*` de graça (mais forte que um caso `a*b` solto).
  // Resíduo conhecido: META espelha o regex do helper (design denylist). Eliminá-lo de vez exigiria
  // migrar o helper para allowlist [A-Za-z0-9…], o que mudaria o comportamento de produção (fora de escopo).
  it('propriedade: nenhum metacaractere sobrevive, qualquer que seja a posição', () => {
    const BENIGNO = 'Tinta Azul-Céu 2.5/3L';
    for (const ch of META) {
      expect(sanitizeForPostgrestOr(ch)).toBe('');
      for (const inj of [`${ch}${BENIGNO}`, `${BENIGNO}${ch}`, `Tin${ch}ta${ch}`]) {
        expect(sanitizeForPostgrestOr(inj).includes(ch)).toBe(false);
      }
    }
  });

  it('payload de injeção combinado vira termo literal inerte', () => {
    const sujo = 'x,id.gt.0,(nome.ilike.%a*b%),"\\_';
    const limpo = sanitizeForPostgrestOr(sujo);
    for (const ch of META) expect(limpo.includes(ch)).toBe(false);
  });
});

describe('ilike', () => {
  it('monta col.ilike.%termo%', () => {
    expect(ilike('nome', 'abc')).toBe('nome.ilike.%abc%');
  });

  it('sanitiza o termo sem quebrar a estrutura', () => {
    expect(ilike('nome', 'a,b')).toBe('nome.ilike.%ab%');
    expect(ilike('nome', 'x,id.gt.0')).toBe('nome.ilike.%xid.gt.0%');
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

  it('não-dígito / decimal / injeção / negativo / vazio → eq.0 (não casa nada)', () => {
    expect(eqInt('id', 'abc')).toBe('id.eq.0');
    expect(eqInt('id', '4.5')).toBe('id.eq.0');
    expect(eqInt('id', '1; DROP TABLE x')).toBe('id.eq.0');
    expect(eqInt('id', '1,role.eq.master')).toBe('id.eq.0'); // valor numérico forjado com injeção
    expect(eqInt('id', '-3')).toBe('id.eq.0');
    expect(eqInt('id', '')).toBe('id.eq.0');
  });
});

describe('eqText', () => {
  it('valor limpo → col.eq.valor', () => {
    expect(eqText('status', 'ativo')).toBe('status.eq.ativo');
  });

  it('preserva máscara de documento (ponto, barra e hífen sobrevivem)', () => {
    expect(eqText('document', '12.345.678/0001-90')).toBe('document.eq.12.345.678/0001-90');
  });

  it('sanitiza o valor (metacaracteres de injeção somem)', () => {
    expect(eqText('status', 'a,b)')).toBe('status.eq.ab');
    expect(eqText('document', 'x),y')).toBe('document.eq.xy');
  });
});

describe('orFilter', () => {
  it('junta cláusulas com vírgula', () => {
    expect(orFilter('a.eq.1', 'b.ilike.%x%')).toBe('a.eq.1,b.ilike.%x%');
  });

  it('compõe com os outros helpers (eqInt + ilike)', () => {
    expect(orFilter(eqInt('codigo', '7'), ilike('descricao', 'tinta'))).toBe(
      'codigo.eq.7,descricao.ilike.%tinta%',
    );
  });

  it('uma cláusula → ela mesma', () => {
    expect(orFilter('a.eq.1')).toBe('a.eq.1');
  });

  it('zero cláusulas → string vazia', () => {
    expect(orFilter()).toBe('');
  });
});
