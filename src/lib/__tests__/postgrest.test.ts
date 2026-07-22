import { describe, it, expect, vi, beforeEach } from 'vitest';

const captureExceptionMock = vi.fn();
vi.mock('@/lib/analytics', () => ({
  captureException: (...a: unknown[]) => captureExceptionMock(...a),
}));

import {
  sanitizeForPostgrestOr,
  sanitizeIlikeTerm,
  ilikeContainsPattern,
  isSearchablePostgrestTerm,
  ilike,
  ilikeOr,
  eqInt,
  eqText,
  orFilter,
  fetchAllPages,
  POSTGREST_PAGE_SIZE,
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

// Gate do contexto `.or()`: o análogo do `ilikeContainsPattern→null` do .ilike() único.
// `ilikeOr`/`ilike`/`orFilter(...ilike...)` NÃO se defendem do termo só-de-wildcards
// (vide hazard nos describes de ilikeOr/ilike abaixo) — quem decide aplicar ou não o
// `.or()` é o caller, e isto responde "tem termo pesquisável?". A condição degenerada é
// EXATAMENTE `sanitizeForPostgrestOr(term) === ''` (= match-all `%%`), cobrindo as 3 formas
// de `.or()` com ilike de uma vez (ilikeOr puro · ilike único · orFilter eqInt+ilike misto).
describe('isSearchablePostgrestTerm', () => {
  it('termo com conteúdo real → true (texto, acento, número p/ shape eqInt+ilike)', () => {
    expect(isSearchablePostgrestTerm('tinta')).toBe(true);
    expect(isSearchablePostgrestTerm('abrasivo 120')).toBe(true);
    expect(isSearchablePostgrestTerm('ção-1.5')).toBe(true);
    expect(isSearchablePostgrestTerm('42')).toBe(true);
    expect(isSearchablePostgrestTerm('007')).toBe(true);
  });

  it('conteúdo + metacaractere no meio → true (sobra texto: a%b → ab)', () => {
    // O gate só barra o caso DEGENERADO (sanitiza pra vazio); termo com qualquer conteúdo
    // real sobrevive — o `*`/`%` do meio vira literal e a busca continua.
    expect(isSearchablePostgrestTerm('a%b')).toBe(true);
    expect(isSearchablePostgrestTerm('4*2')).toBe(true);
  });

  it('input só-de-metacaracteres do .or() → false (o caso degenerado) — derivado da gramática', () => {
    // Cada metacaractere que sanitizeForPostgrestOr strippa, sozinho, colapsa pra vazio.
    // Itera META (não payload escolhido a dedo): esquecer qualquer um faz o laço falhar.
    for (const ch of META) expect(isSearchablePostgrestTerm(ch)).toBe(false);
    for (const s of ['**', '%%', '%_*', '()', '(),', '*,()', '%,(', META.join('')]) {
      expect(isSearchablePostgrestTerm(s)).toBe(false);
    }
  });

  it('vírgula/parênteses-só → false (usa sanitizeForPostgrestOr, NÃO sanitizeIlikeTerm)', () => {
    // Falsificação embutida: sanitizeIlikeTerm PRESERVA , ( ) " — se o helper usasse ELE,
    // `(),` sobreviveria como '(),' (≠ vazio) e isto viraria true. O contexto .or() parseia
    // esses chars, então têm que zerar → false.
    expect(isSearchablePostgrestTerm('(),')).toBe(false);
    expect(isSearchablePostgrestTerm(',,,')).toBe(false);
    expect(isSearchablePostgrestTerm('"\\"')).toBe(false);
  });

  it('string vazia → false', () => {
    expect(isSearchablePostgrestTerm('')).toBe(false);
  });

  it('contrato gate⟺hazard: false ⟺ ilikeOr/ilike colapsariam pro %% (match-all)', () => {
    // Liga o gate ao hazard: quando false, o predicado que o caller DEIXA de aplicar seria
    // o match-all degenerado; quando true, sobra conteúdo e não há `%%`.
    const cols = ['a', 'b'];
    for (const t of ['*', '%%', '**', '(),', '']) {
      expect(isSearchablePostgrestTerm(t)).toBe(false);
      expect(ilikeOr(cols, t)).toBe('a.ilike.%%,b.ilike.%%');
      expect(ilike('a', t)).toBe('a.ilike.%%');
    }
    for (const t of ['tinta', '42', 'a%b']) {
      expect(isSearchablePostgrestTerm(t)).toBe(true);
      expect(ilikeOr(cols, t)).not.toContain('.ilike.%%');
    }
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

  it('HAZARD: termo só-wildcard colapsa pro %% (match-all) — caller deve gatear com isSearchablePostgrestTerm', () => {
    // ilike() não se defende sozinho: `*`/`()` sanitizam pra vazio → `col.ilike.%%`, que
    // dentro do `.or()` casa todo valor não-nulo da coluna. A defesa vive no gate do caller.
    expect(ilike('a', '*')).toBe('a.ilike.%%');
    expect(ilike('a', '()')).toBe('a.ilike.%%');
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

  it('HAZARD: termo só-wildcard colapsa cada cláusula pro %% (match-all) — caller deve gatear', () => {
    // `*`/`%%`/`**` → cada coluna vira `col.ilike.%%` = match-all dos não-nulos dentro do
    // `.or()`. ilikeOr não se defende; a defesa é o gate `isSearchablePostgrestTerm` no caller
    // (espelha o ilikeContainsPattern→null que o #1062 usou no .ilike() único).
    expect(ilikeOr(['a', 'b'], '*')).toBe('a.ilike.%%,b.ilike.%%');
    expect(ilikeOr(['a', 'b'], '%%')).toBe('a.ilike.%%,b.ilike.%%');
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

/**
 * Instrumentação — a página perdida para de sumir das MÉTRICAS.
 *
 * Rejeitar conserta a mentira do número: o caller não recebe mais um total plausível e falso.
 * Mas a falha continuava invisível para MEDIÇÃO — sem telemetria não dá para saber se acontece
 * uma vez por mês ou toda tarde, nem se um caller sofre mais que os outros. Antes do contrato
 * de rejeição isso era impossível por construção (a falha virava lista vazia); depois dele, a
 * exceção sobe e o caller pode tratá-la sem que ninguém saiba que aconteceu.
 */
describe('fetchAllPages — instrumentação da página perdida', () => {
  const ERRO_RLS = { code: '42501', message: 'permission denied for table product_costs' };

  const falhaNaTerceira = (de: number) =>
    de >= 2 * POSTGREST_PAGE_SIZE
      ? Promise.resolve({ data: null, error: ERRO_RLS })
      : Promise.resolve({
          data: Array.from({ length: POSTGREST_PAGE_SIZE }, (_, i) => ({ id: de + i })),
          error: null,
        });

  beforeEach(() => captureExceptionMock.mockClear());

  it('reporta fonte, índice da página, linhas perdidas e o código do PostgREST', async () => {
    await expect(
      fetchAllPages<{ id: number }>(falhaNaTerceira, 'product_costs/bundle'),
    ).rejects.toThrow();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(ctx.fonte).toBe('product_costs/bundle');
    expect(ctx.pagina).toBe(2); // 0-based, igual à mensagem do throw
    expect(ctx.linhas_perdidas).toBe(2 * POSTGREST_PAGE_SIZE);
    expect(ctx.codigo).toBe('42501');
    expect(ctx.mensagem).toBe('permission denied for table product_costs');
  });

  it('NÃO envia as linhas lidas — metadado só, sem payload nem PII', async () => {
    await expect(fetchAllPages<{ id: number }>(falhaNaTerceira, 'product_costs/bundle')).rejects.toThrow();

    const [, ctx] = captureExceptionMock.mock.calls[0] as [unknown, Record<string, unknown>];
    // `linhas_perdidas` é uma CONTAGEM; as linhas em si nunca entram no contexto.
    expect(JSON.stringify(ctx)).not.toMatch(/"id"/);
    for (const v of Object.values(ctx)) expect(Array.isArray(v)).toBe(false);
  });

  it('data:null sem error também reporta (rotulado, não confundido com timeout)', async () => {
    await expect(
      fetchAllPages<{ id: number }>(() => Promise.resolve({ data: null, error: null }), 'x/y'),
    ).rejects.toThrow();

    const [, ctx] = captureExceptionMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(ctx.codigo).toBeNull();
    expect(ctx.mensagem).toBe('data=null sem error');
  });

  it('leitura completa não instrumenta nada (sem ruído na telemetria)', async () => {
    const linhas = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
    await fetchAllPages<{ id: number }>(
      (de, ate) => Promise.resolve({ data: linhas.slice(de, ate + 1), error: null }),
      'x/y',
    );
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});

describe('fetchAllPages — a capa de 1.000 do PostgREST é silenciosa', () => {
  // Simula o PostgREST: devolve no máximo POSTGREST_PAGE_SIZE linhas por request,
  // truncando sem erro — exatamente o comportamento que engana quem não pagina.
  // `falharNaPagina` injeta a resposta de FALHA real do PostgREST (`{ data: null, error }`)
  // numa página específica: é assim que timeout (57014), RLS e 500 chegam ao helper.
  const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };
  const tabelaFalsa = (total: number, falharNaPagina?: number) => {
    const linhas = Array.from({ length: total }, (_, i) => ({ id: i }));
    const chamadas: [number, number][] = [];
    const buscar = (de: number, ate: number) => {
      // Índice derivado da JANELA pedida, não de `chamadas.length`: um contador cumulativo
      // deixaria de injetar a falha se o mesmo fake fosse reusado numa segunda chamada.
      const pagina = de / POSTGREST_PAGE_SIZE;
      chamadas.push([de, ate]);
      if (pagina === falharNaPagina) return Promise.resolve({ data: null, error: ERRO_TIMEOUT });
      const fatia = linhas.slice(de, Math.min(ate + 1, de + POSTGREST_PAGE_SIZE));
      return Promise.resolve({ data: fatia, error: null });
    };
    return { buscar, chamadas };
  };

  it('tabela maior que a capa: devolve TUDO, não as primeiras 1.000', async () => {
    const { buscar } = tabelaFalsa(3637); // product_costs real
    const todas = await fetchAllPages(buscar);
    expect(todas).toHaveLength(3637);
    expect(todas.at(-1)).toEqual({ id: 3636 }); // a cauda chegou
  });

  it('pagina com janelas contíguas e para na primeira página parcial', async () => {
    const { buscar, chamadas } = tabelaFalsa(2500);
    await fetchAllPages(buscar);
    expect(chamadas).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('múltiplo exato da capa: faz uma página extra vazia e para (sem loop infinito)', async () => {
    const { buscar, chamadas } = tabelaFalsa(2000);
    const todas = await fetchAllPages(buscar);
    expect(todas).toHaveLength(2000);
    expect(chamadas).toHaveLength(3);
  });

  it('tabela menor que a capa: uma única requisição', async () => {
    const { buscar, chamadas } = tabelaFalsa(42);
    expect(await fetchAllPages(buscar)).toHaveLength(42);
    expect(chamadas).toHaveLength(1);
  });

  // ─── Fim LEGÍTIMO da tabela: `data: []` SEM erro. Encerra normalmente. ───────────────
  // Mantido separado dos casos de falha de propósito: é a única leitura em que "veio vazio"
  // significa mesmo "acabou". Confundir os dois foi o bug que este bloco fecha.

  it('tabela vazia → lista vazia, sem estourar', async () => {
    const { buscar, chamadas } = tabelaFalsa(0);
    expect(await fetchAllPages(buscar)).toEqual([]);
    expect(chamadas).toHaveLength(1);
  });

  // ─── Falha de página: REJEITA. Página perdida ≠ fim da tabela. ───────────────────────
  // O helper existe pra evitar leitura parcial silenciosa (a capa de 1.000). Encerrar o loop
  // numa página que FALHOU reintroduzia o mesmo defeito por outra via: o acumulado parcial
  // voltava como se a tabela tivesse acabado, e o contrato nem expunha `error` pro caller
  // detectar. Paginar cura a capa, não a falha no meio.

  // As asserções abaixo casam a JANELA + `falhou` — string ASCII EXCLUSIVA do ramo de erro.
  // Casar só "página N" não teria dente: sabotando o guard de `error`, a execução cai no ramo
  // seguinte (`data null`), cuja mensagem também contém "página N" — o teste passaria verde
  // com o bug de volta. Cada asserção tem que distinguir QUAL ramo disparou.
  it('erro na PRIMEIRA página → REJEITA (não devolve [] como se a tabela estivesse vazia)', async () => {
    const { buscar } = tabelaFalsa(3637, 0);
    await expect(fetchAllPages(buscar)).rejects.toThrow(/\(0-999\) falhou/);
  });

  it('O CORAÇÃO DO FIX: erro numa página do MEIO → REJEITA, nunca devolve o acumulado parcial', async () => {
    // Farmer de 3.858 clientes perdendo a 3ª página: o comportamento antigo devolvia 2.000
    // linhas — numericamente indistinguível de uma carteira que de fato tem 2.000. Nos três
    // callers de `product_costs` a mesma perda vira "SKU sem custo", que INFLA margem.
    const { buscar, chamadas } = tabelaFalsa(3858, 2);
    await expect(fetchAllPages(buscar)).rejects.toThrow(/\(2000-2999\) falhou/);
    expect(chamadas).toHaveLength(3); // parou NA página que falhou; não seguiu adiante
  });

  it('a rejeição carrega a janela e preserva o erro original (diagnóstico do incidente)', async () => {
    // Sem a janela e a causa, o incidente chega como "deu erro" e não dá pra saber QUAL
    // fatia da tabela sumiu nem se foi timeout, RLS ou 500.
    const { buscar } = tabelaFalsa(3858, 2);
    const erro = await fetchAllPages(buscar).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(Error); // se RESOLVEU, cai aqui mostrando o parcial devolvido
    expect((erro as Error).message).toMatch(/\(2000-2999\) falhou/); // a janela que sumiu
    expect((erro as Error & { cause?: unknown }).cause).toEqual(ERRO_TIMEOUT); // timeout? RLS? 500?
  });

  it('data null SEM erro → REJEITA (resposta malformada não é "fim da tabela")', async () => {
    // O ÚNICO sinal legítimo de fim é `data: []`. Aceitar `data: null` como EOF deixaria o
    // mesmo buraco aberto pra qualquer lambda que engula o erro no caminho até aqui.
    // Casa a mensagem do RAMO (não um throw qualquer): sem o guard, `push(...null)` lançaria
    // TypeError e um `rejects.toThrow()` pelado passaria verde pelo motivo errado.
    await expect(
      fetchAllPages<{ id: number }>(() => Promise.resolve({ data: null, error: null })),
    ).rejects.toThrow(/data null sem error/);
  });
});
