import { describe, it, expect } from 'vitest';
import {
  sanitizeForPostgrestOr,
  sanitizeIlikeTerm,
  ilikeContainsPattern,
  ilike,
  ilikeOr,
  eqInt,
  eqText,
  orFilter,
} from '../postgrest';

// Os metacaracteres que o parser do .or() interpreta — nenhum pode sobreviver à sanitização.
// `*` entra porque o PostgREST o trata como alias de `%` em like/ilike (truque pra evitar URL-encoding).
const META = ['%', '_', ',', '(', ')', '\\', '"', '*'];

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

  it('remove o asterisco — PostgREST trata * como alias de % em like/ilike', () => {
    // postgrest.org (tables_views): "to avoid URL encoding you can use * as an alias
    // of the percent sign %". Logo `a*b` viraria o padrão `%a%b%` no ILIKE — wildcard
    // injection que o bloqueio de % e _ sozinho NÃO cobre.
    expect(sanitizeForPostgrestOr('a*b')).toBe('ab');
  });

  it('neutraliza o vetor de injeção (vírgula+paren somem → vira termo literal)', () => {
    expect(sanitizeForPostgrestOr('%,id.gt.0,(')).toBe('id.gt.0');
  });

  it('propriedade de segurança: NENHUM metacaractere sobra, qualquer que seja a entrada', () => {
    const sujo = 'x,id.gt.0,(nome.ilike.%a*b%),"\\_';
    const limpo = sanitizeForPostgrestOr(sujo);
    for (const ch of META) expect(limpo.includes(ch)).toBe(false);
  });

  it('string vazia → string vazia', () => {
    expect(sanitizeForPostgrestOr('')).toBe('');
  });
});

// Os 3 wildcards do operador LIKE/ILIKE, derivados da GRAMÁTICA do PostgREST (não da
// memória do autor): `%` (qualquer sequência), `_` (um caractere) e `*` — alias de `%`
// em like/ilike pra evitar URL-encoding (postgrest.org, tables_views). Foi derivar da
// intuição (só `%`/`_`) e ESQUECER o `*` que abriu o gap nos `.ilike()` crus.
const ILIKE_WILDCARDS = ['%', '_', '*'];

describe('sanitizeIlikeTerm', () => {
  it('remove cada wildcard do ILIKE — entrada derivada da própria gramática', () => {
    // Deriva tanto a entrada quanto a verificação da constante: se o helper esquecer
    // QUALQUER wildcard da lista (como o `*` original), este laço falha.
    for (const w of ILIKE_WILDCARDS) {
      expect(sanitizeIlikeTerm(`a${w}b`)).toBe('ab');
    }
    expect(sanitizeIlikeTerm(`x${ILIKE_WILDCARDS.join('')}y`)).toBe('xy');
  });

  it('remove o asterisco — alias de % (o gap que o .replace(/[%_]/g) deixou passar)', () => {
    // `.ilike('col', `%${'*'}%`)` → o servidor traduz `%*%` em `%%%` = match-all dos
    // valores não-nulos da coluna. Strippar só `%`/`_` NÃO cobre esse vetor.
    expect(sanitizeIlikeTerm('*')).toBe('');
    expect(sanitizeIlikeTerm('a*b*c')).toBe('abc');
  });

  it('PRESERVA vírgula/parênteses/aspas — num .ilike() único não são metacaracteres (≠ sanitizeForPostgrestOr)', () => {
    // Contraste de CONTRATO: o `.or()` parseia vírgula/parênteses (separador/grupo), então
    // sanitizeForPostgrestOr os remove. Num `.ilike()` único o pattern é o valor de UM
    // predicado — esses caracteres são literais legítimos da busca e devem sobreviver.
    expect(sanitizeIlikeTerm('a,b(c)"d')).toBe('a,b(c)"d');
  });

  it('texto limpo passa inalterado (espaço, dígito, acento, hífen, ponto)', () => {
    expect(sanitizeIlikeTerm('abrasivo 120')).toBe('abrasivo 120');
    expect(sanitizeIlikeTerm('ção-1.5')).toBe('ção-1.5');
  });

  it('propriedade de segurança: NENHUM wildcard do ILIKE sobra, qualquer que seja a entrada', () => {
    const sujo = 'cor*_50%off_(a)';
    const limpo = sanitizeIlikeTerm(sujo);
    for (const w of ILIKE_WILDCARDS) expect(limpo.includes(w)).toBe(false);
  });

  it('string vazia → string vazia', () => {
    expect(sanitizeIlikeTerm('')).toBe('');
  });
});

describe('ilikeContainsPattern', () => {
  it('termo com texto → `%termo%` com wildcards strippados', () => {
    expect(ilikeContainsPattern('abc')).toBe('%abc%');
    expect(ilikeContainsPattern('a*b')).toBe('%ab%'); // wildcard no meio vira literal
    expect(ilikeContainsPattern('ção 120')).toBe('%ção 120%');
  });

  it('input só-de-wildcards → null (NÃO vira `%%` match-all) — o gap que o /codex achou', () => {
    // `%${sanitizeIlikeTerm('*')}%` seria `%%` = match-all dos não-nulos da coluna.
    // Retornar null sinaliza ao caller pra NÃO aplicar o .ilike (busca sem texto).
    expect(ilikeContainsPattern('*')).toBeNull();
    expect(ilikeContainsPattern('%')).toBeNull();
    expect(ilikeContainsPattern('_')).toBeNull();
    expect(ilikeContainsPattern('**')).toBeNull();
    expect(ilikeContainsPattern('%_*')).toBeNull();
  });

  it('input vazio → null', () => {
    expect(ilikeContainsPattern('')).toBeNull();
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
