import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  type Consultas,
  FORMATO_TRANSPORTE,
  gerarSqlNuvem,
  IDADE_MAXIMA_MIN,
  leitorNuvem,
  lerDadosNuvem,
  registroParaLinha,
  TETO_TRANSPORTE,
} from './transporte-nuvem';

const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');
/** O trecho que o banco hasheia: do 1º caractere até o fim da marca final (o rastro do MCP fica fora). */
const trechoDoBanco = (sql: string): string => sql.slice(0, sql.indexOf('sql-nuvem:fim') + 'sql-nuvem:fim'.length);

const CONSULTAS: Consultas = {
  observacoes: "SELECT edge, versao\nFROM public.x\nORDER BY edge;",
  saude: "SELECT coalesce(max(v)::text, 'nunca') FROM public.y;",
};
const CONSUMIDOR = 'teste-transporte';
const AGORA = new Date('2026-09-27T12:00:00Z');

/**
 * Monta a resposta como o BANCO a montaria: `sql_md5` sobre o trecho marcado do SQL executado e o
 * md5 sobre a forma canônica do `concat_ws`. O que a prova de equivalência (`db/test-transporte-
 * nuvem.sh`) mede contra um Postgres de verdade, aqui é premissa — por isso a conta é refeita à
 * parte, não importada do módulo que ela testa.
 */
function respostaDoBanco(
  linhas: Record<string, string[]>,
  o: {
    sqlExecutado?: string;
    medidoEm?: string;
    somenteLeitura?: string;
    teto?: string;
    marcas?: string;
    consumidor?: string;
  } = {},
): Record<string, unknown> {
  const sql = o.sqlExecutado ?? gerarSqlNuvem(CONSULTAS, CONSUMIDOR);
  const consumidor = o.consumidor ?? CONSUMIDOR;
  const medidoEm = o.medidoEm ?? '2026-09-27T11:58:00Z';
  const somenteLeitura = o.somenteLeitura ?? 'on';
  const teto = o.teto ?? TETO_TRANSPORTE;
  const marcas = o.marcas ?? '1/1';
  const sqlMd5 = md5(trechoDoBanco(sql));
  const canonico = [FORMATO_TRANSPORTE, consumidor, medidoEm, somenteLeitura, teto, sqlMd5, marcas];
  for (const n of Object.keys(linhas).sort()) canonico.push(n, String(linhas[n].length), linhas[n].join('\n'));
  return {
    formato: FORMATO_TRANSPORTE,
    consumidor,
    medido_em: medidoEm,
    somente_leitura: somenteLeitura,
    teto,
    sql_md5: sqlMd5,
    marcas,
    consultas: linhas,
    md5: md5(canonico.join('\n')),
  };
}

/** O payload traz o literal de REGISTRO (`record_out`), não a linha do psql — é o que o banco emite. */
const LINHAS = { observacoes: ['(a,v1)', '(b,v2)'], saude: ['(12.5)'] };
const ler = (payload: unknown) =>
  lerDadosNuvem(JSON.stringify(payload), { consultas: CONSULTAS, consumidor: CONSUMIDOR }, AGORA);

describe('gerarSqlNuvem', () => {
  it('a 1ª linha é a trava de leitura e o teto; a última fecha na marca final', () => {
    const linhas = gerarSqlNuvem(CONSULTAS, CONSUMIDOR).split('\n');
    expect(linhas[0]).toBe(`SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '${TETO_TRANSPORTE}';`);
    expect(linhas[linhas.length - 1]).toBe("(SELECT 'sql-nuvem:fim'::text AS fim) AS __sql_nuvem_marca_fim__;");
  });

  it('cada marca aparece UMA vez — é o que deixa o banco achar o trecho sem ambiguidade', () => {
    const sql = gerarSqlNuvem(CONSULTAS, CONSUMIDOR);
    expect(sql.split('sql-nuvem:inicio').length - 1).toBe(1);
    expect(sql.split('sql-nuvem:fim').length - 1).toBe(1);
  });

  it('é determinístico e independe da ordem das chaves', () => {
    const invertidas: Consultas = { saude: CONSULTAS.saude, observacoes: CONSULTAS.observacoes };
    expect(gerarSqlNuvem(invertidas, CONSUMIDOR)).toBe(gerarSqlNuvem(CONSULTAS, CONSUMIDOR));
  });

  it('embute a consulta INTEIRA, com as quebras de linha dela, sem o ; final', () => {
    const sql = gerarSqlNuvem(CONSULTAS, CONSUMIDOR);
    expect(sql).toContain('FROM (\nSELECT edge, versao\nFROM public.x\nORDER BY edge\n) AS __sql_nuvem_linha__');
  });

  // Sem juntar linhas, nada disto muda de sentido no caminho — a prova no Postgres executa os casos.
  it.each([
    ['comentário de linha no fim', 'SELECT 1 -- x'],
    ['comentário de bloco com aspa', "SELECT /* it's */ 1"],
    ['dollar-quoting com quebra de linha', 'SELECT $q$a\nb$q$'],
    ['aspa escapada por barra', "SELECT E'a\\'b'"],
    ['literal atravessando linha', "SELECT 'a\nb'"],
  ])('aceita %s e a embute sem mexer', (_caso, sql) => {
    expect(gerarSqlNuvem({ q: sql }, CONSUMIDOR)).toContain(`FROM (\n${sql}\n) AS __sql_nuvem_linha__`);
  });

  it.each([
    ['multi-statement', 'SELECT 1; SELECT 2', /TRANSPORTE_CONSULTA_INVALIDA: .*';' no meio/],
    ['marca dentro da consulta', "SELECT 'sql-nuvem:fim'", /TRANSPORTE_CONSULTA_INVALIDA: .*marca do transporte/],
    ['namespace interno', 'SELECT 1 AS __sql_nuvem_x', /TRANSPORTE_CONSULTA_INVALIDA: .*namespace interno/],
    ['tabulação', 'SELECT\t1', /TRANSPORTE_CONSULTA_INVALIDA: .*controle/],
    ['CR de fim de linha do Windows', 'SELECT 1\r\nFROM x', /TRANSPORTE_CONSULTA_INVALIDA: .*controle/],
    ['vazia', '  ;  ', /TRANSPORTE_CONSULTA_INVALIDA: .*vazia/],
  ])('recusa consulta com %s', (_caso, sql, marca) => {
    expect(() => gerarSqlNuvem({ q: sql }, CONSUMIDOR)).toThrow(marca);
  });

  it('aceita acento e espaço duplo DENTRO do literal (a amostra do autoteste do pacote)', () => {
    expect(gerarSqlNuvem({ q: "SELECT md5(E'\\n á  b ')" }, CONSUMIDOR)).toContain("md5(E'\\n á  b ')");
  });

  it('recusa nome de consulta/consumidor fora do formato e pacote vazio', () => {
    expect(() => gerarSqlNuvem({ 'Nome-Ruim': 'SELECT 1' }, CONSUMIDOR)).toThrow(/TRANSPORTE_CONSULTA_INVALIDA: nome/);
    expect(() => gerarSqlNuvem({ q: 'SELECT 1' }, "x'y")).toThrow(/TRANSPORTE_CONSULTA_INVALIDA: consumidor/);
    expect(() => gerarSqlNuvem({}, CONSUMIDOR)).toThrow(/TRANSPORTE_CONSULTA_INVALIDA: 0 consulta/);
  });
});

describe('lerDadosNuvem', () => {
  it('aceita a resposta íntegra e devolve as linhas por consulta', () => {
    const d = ler(respostaDoBanco(LINHAS));
    expect(d.saidas.get('observacoes')).toBe('a|v1\nb|v2');
    expect(d.saidas.get('saude')).toBe('12.5');
    expect(d.medidoEm.toISOString()).toBe('2026-09-27T11:58:00.000Z');
  });

  it('aceita as embalagens em que a resposta chega (rows, string, blocos de ferramenta)', () => {
    const p = respostaDoBanco(LINHAS);
    const rows = { rows: [{ dados_nuvem: p }] };
    expect(ler(rows).saidas.get('saude')).toBe('12.5');
    expect(ler({ rows: [{ dados_nuvem: JSON.stringify(p) }] }).saidas.get('saude')).toBe('12.5');
    expect(ler([{ type: 'text', text: JSON.stringify(rows) }]).saidas.get('saude')).toBe('12.5');
  });

  it('TRANSPORTE_MD5: uma linha trocada na transcrição', () => {
    const p = respostaDoBanco(LINHAS) as { consultas: Record<string, string[]> };
    p.consultas.observacoes = ['(a,v1)', '(b,v9)'];
    expect(() => ler(p)).toThrow(/TRANSPORTE_MD5/);
  });

  it('TRANSPORTE_MD5: uma linha a menos (resposta truncada)', () => {
    const p = respostaDoBanco(LINHAS) as { consultas: Record<string, string[]> };
    p.consultas.observacoes = ['(a,v1)'];
    expect(() => ler(p)).toThrow(/TRANSPORTE_MD5/);
  });

  it('TRANSPORTE_FORMATO: registro que não é literal de registro, mesmo com o md5 fechando', () => {
    expect(() => ler(respostaDoBanco({ ...LINHAS, saude: ['12.5'] }))).toThrow(/TRANSPORTE_FORMATO: registro/);
  });

  it('TRANSPORTE_MD5: atestado de leitura trocado à mão não fecha a conta', () => {
    const p = respostaDoBanco(LINHAS, { somenteLeitura: 'off' });
    p.somente_leitura = 'on';
    expect(() => ler(p)).toThrow(/TRANSPORTE_MD5/);
  });

  it('TRANSPORTE_SOMENTE_LEITURA: o banco disse off (statements separados)', () => {
    expect(() => ler(respostaDoBanco(LINHAS, { somenteLeitura: 'off' }))).toThrow(/TRANSPORTE_SOMENTE_LEITURA/);
  });

  it('TRANSPORTE_TETO: statement_timeout diferente do wrapper local', () => {
    expect(() => ler(respostaDoBanco(LINHAS, { teto: '0' }))).toThrow(/TRANSPORTE_TETO/);
  });

  it('TRANSPORTE_SQL_DIVERGENTE: o banco executou um SQL diferente do emitido', () => {
    const alterado = gerarSqlNuvem(CONSULTAS, CONSUMIDOR).replace('ORDER BY edge', 'ORDER BY versao');
    expect(() => ler(respostaDoBanco(LINHAS, { sqlExecutado: alterado }))).toThrow(/TRANSPORTE_SQL_DIVERGENTE/);
  });

  it('TRANSPORTE_SQL_DIVERGENTE: statement enfiado ANTES da trava (o hash cobre do 1º caractere)', () => {
    const sql = gerarSqlNuvem(CONSULTAS, CONSUMIDOR);
    const comPrefixo = `INSERT INTO public.x VALUES (1); ${sql}`;
    expect(() => ler(respostaDoBanco(LINHAS, { sqlExecutado: comPrefixo }))).toThrow(/TRANSPORTE_SQL_DIVERGENTE/);
  });

  it('aceita o rastro que o query_database acrescenta DEPOIS da marca final (medido em prod)', () => {
    const sql = gerarSqlNuvem(CONSULTAS, CONSUMIDOR);
    const comRastro = `${sql}\n-- rastro do conector, date: 2026-09-27T17:07:46.950Z`;
    expect(ler(respostaDoBanco(LINHAS, { sqlExecutado: comRastro })).saidas.get('saude')).toBe('12.5');
  });

  it('TRANSPORTE_SQL_DIVERGENTE: o lote carregava o SQL do transporte duas vezes (marcas 2/2)', () => {
    expect(() => ler(respostaDoBanco(LINHAS, { marcas: '2/2' }))).toThrow(/TRANSPORTE_SQL_DIVERGENTE: .*2\/2 marcas/);
  });

  it.each([['2026-13-01T00:00:00Z'], ['2026-02-30T11:58:00Z'], ['2026-09-27 11:58:00']])(
    'TRANSPORTE_FORMATO: medido_em %s não é um instante que o banco escreveria',
    (medidoEm) => {
      expect(() => ler(respostaDoBanco(LINHAS, { medidoEm }))).toThrow(/TRANSPORTE_FORMATO: medido_em/);
    },
  );

  it('TRANSPORTE_VELHO e TRANSPORTE_FUTURO: relógio do banco fora da janela', () => {
    const velho = new Date(AGORA.getTime() - (IDADE_MAXIMA_MIN + 1) * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    expect(() => ler(respostaDoBanco(LINHAS, { medidoEm: velho }))).toThrow(/TRANSPORTE_VELHO/);
    expect(() => ler(respostaDoBanco(LINHAS, { medidoEm: '2026-09-27T12:30:00Z' }))).toThrow(/TRANSPORTE_FUTURO/);
  });

  it('TRANSPORTE_CONSULTAS: consulta faltando ou sobrando', () => {
    expect(() => ler(respostaDoBanco({ observacoes: ['a|v1'] }))).toThrow(/TRANSPORTE_CONSULTAS/);
    expect(() => ler(respostaDoBanco({ ...LINHAS, extra: [] }))).toThrow(/TRANSPORTE_CONSULTAS/);
  });

  it('TRANSPORTE_FORMATO: arquivo que não é JSON, formato ou consumidor de outra leitura', () => {
    expect(() => lerDadosNuvem('SET\n{', { consultas: CONSULTAS, consumidor: CONSUMIDOR }, AGORA)).toThrow(/TRANSPORTE_FORMATO/);
    expect(() => ler({ ...respostaDoBanco(LINHAS), formato: 'x/9' })).toThrow(/TRANSPORTE_FORMATO/);
    expect(() => ler(respostaDoBanco(LINHAS, { consumidor: 'outro' }))).toThrow(/TRANSPORTE_FORMATO/);
    expect(() => ler({ rows: [] })).toThrow(/TRANSPORTE_FORMATO/);
    const semMarcas: Record<string, unknown> = respostaDoBanco(LINHAS);
    delete semMarcas.marcas;
    expect(() => ler(semMarcas)).toThrow(/TRANSPORTE_FORMATO: campo 'marcas'/);
  });
});

describe('registroParaLinha — o envelope do record_out sai, o campo fica', () => {
  // Formas copiadas do `record_out` do Postgres 16/17 (medidas em `db/test-transporte-nuvem.sh`):
  // aspas quando o campo é vazio ou tem `"`, `\`, `(`, `)`, `,` ou espaço; `"` e `\` dobrados.
  it.each([
    ['(a,v1)', 'a|v1'],
    ['(12.5)', '12.5'],
    ['()', ''],
    ['(,)', '|'],
    ['("",x)', '|x'],
    ['(t,f,)', 't|f|'],
    ['("2026-09-26 12:00:00+00",5.00)', '2026-09-26 12:00:00+00|5.00'],
    ['("a""b\\\\c (x), y",1)', 'a"b\\c (x), y|1'],
    ['("{1,2,NULL}","{""k"": 1}")', '{1,2,NULL}|{"k": 1}'],
    ['("á  b|c",-0.000)', 'á  b|c|-0.000'],
  ])('%s → %s', (registro, linha) => {
    expect(registroParaLinha(registro)).toBe(linha);
  });

  it.each([['12.5'], ['(a'], ['a)'], ['("a)'], ['(a(b)'], ['(a\\)']])('recusa %s', (registro) => {
    expect(() => registroParaLinha(registro)).toThrow(/TRANSPORTE_FORMATO: registro/);
  });
});

describe('leitorNuvem', () => {
  it('devolve a saída pelo TEXTO do SQL e recusa consulta fora do pacote', () => {
    const lerSql = leitorNuvem(ler(respostaDoBanco(LINHAS)), CONSULTAS);
    expect(lerSql(CONSULTAS.saude)).toBe('12.5');
    expect(() => lerSql('SELECT 1')).toThrow(/TRANSPORTE_FORA_DO_PACOTE/);
  });
});
