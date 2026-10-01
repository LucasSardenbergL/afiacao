/**
 * `deriva:corpo:prod` pela NUVEM (`--sql-nuvem` / `--dados-nuvem`) — o MESMO veredito do `psql-ro`.
 *
 * O runner (`db/audit-deriva-corpo-prod.ts`) recebe o mundo por injeção. Cada mundo de prod é uma
 * lista de linhas por consulta; das MESMAS linhas sai o texto do psql falso e o payload montado como
 * o banco montaria (`lib/transporte-nuvem-fixture.ts`). Os dois caminhos têm de devolver o mesmo
 * exit e as mesmas linhas, byte a byte — e cada mundo tem de dar o veredito para o qual existe
 * (senão "iguais" pode ser só os dois quebrados do mesmo jeito).
 */
import { describe, expect, it } from 'vitest';

import { CONSUMIDOR_NUVEM, type Dependencias, executar } from '../db/audit-deriva-corpo-prod';

import { consultasDeriva } from './lib/deriva-corpo';
import { md5Exato } from './lib/migration-objects';
import { AMOSTRA_CORPO_JS, FORMATO_SONDA } from './lib/precondicao-banco';
import { gerarSqlNuvem } from './lib/transporte-nuvem';
import { linhaDoPsql, registroDoBanco, respostaDoBanco } from './lib/transporte-nuvem-fixture';

const fn = (nome: string, args: string, corpo: string) =>
  `CREATE OR REPLACE FUNCTION public.${nome}(${args}) RETURNS int LANGUAGE sql AS $$${corpo}$$;\n`;

/** O repo: `f()` redefinida (a 2ª vence) e `g(integer)`. */
const MIGRATIONS = [
  { nome: '20260101000000_a.sql', sql: fn('f', '', ' SELECT 1 ') + fn('g', 'p int', ' SELECT 2 ') },
  { nome: '20260102000000_b.sql', sql: fn('f', '', ' SELECT 3 ') },
];
const SHA = '0123456789abcdef0123456789abcdef01234567';
const AGORA = new Date('2026-10-01T12:00:00Z');
const MEDIDO_EM = '2026-10-01T11:59:00Z';

type Campos = (string | null)[];
interface Overload {
  nome: string;
  identidade: string;
  corpo: string;
  xmin: number;
}
interface Mundo {
  sonda: Campos[];
  detalhe: Campos[];
}

const hex = (t: string) => Buffer.from(t, 'utf8').toString('hex');

/**
 * As linhas que o banco devolveria às duas consultas da sonda, para os overloads vivos dados — na
 * forma das consultas de `consultasDeriva` (a do gate do pacote e o detalhe por overload).
 */
function mundoCom(vivos: Overload[], o: { semFimDetalhe?: boolean } = {}): Mundo {
  const nomes = ['f', 'g'];
  const conta = (n: string) => vivos.filter((v) => v.nome === n).length;
  const sonda: Campos[] = [
    ...nomes.map((n): Campos => ['rpc', n, conta(n) > 0 ? 'SIM' : 'NAO', '0']),
    ['controle', 'funcoes_public', '489', ''],
    ['autoteste', 'ausente', 'NAO', ''],
    ['autoteste', 'md5corpo', md5Exato(AMOSTRA_CORPO_JS), ''],
    ['autoteste', 'presente', 'SIM', ''],
    ...vivos.map((v): Campos => ['corpo', v.nome, md5Exato(v.corpo), String(conta(v.nome))]),
    ['fim', FORMATO_SONDA, '', ''],
  ];
  const detalhe: Campos[] = [
    ...vivos.map((v): Campos => ['fn', v.nome, v.identidade, String(v.xmin), md5Exato(v.corpo), hex(v.corpo)]),
    ...nomes.map((n): Campos => ['n', n, String(conta(n)), '', '', '']),
    ['agora', '2026-10-01 11:59:00.123456', '', '', '', ''],
    ['autoteste-hex', hex(AMOSTRA_CORPO_JS), '', '', '', ''],
    ['autoteste-id', 'integer,text,timestamp with time zone,character varying', '', '', '', ''],
    ...(o.semFimDetalhe ? [] : [['fim-deriva', 'deriva-corpo/1', '', '', '', ''] as Campos]),
  ];
  return { sonda, detalhe };
}

const EM_DIA: Overload[] = [
  { nome: 'f', identidade: '', corpo: ' SELECT 3 ', xmin: 900 },
  { nome: 'g', identidade: 'integer', corpo: ' SELECT 2 ', xmin: 901 },
];

/** O mundo injetado: repo fixo, psql falso que imprime as linhas do mundo, arquivo da nuvem dado. */
function deps(mundo: Mundo, arquivo?: string): Dependencias & { sqls: string[] } {
  const sqls: string[] = [];
  return {
    sqls,
    carregarEntrada: () => ({ lidas: MIGRATIONS, baseline: [], sha: SHA, fetch: true }),
    psql: (sql) => {
      sqls.push(sql);
      // `BEGIN; <sonda>; <detalhe>; COMMIT;` com `-q -tA`: os dois result sets em sequência.
      return [...mundo.sonda, ...mundo.detalhe].map((c) => `${linhaDoPsql(c)}\n`).join('');
    },
    lerArquivo: () => {
      if (arquivo === undefined) throw new Error('TRANSPORTE_ARQUIVO: sem arquivo no teste');
      return arquivo;
    },
    agora: () => AGORA,
  };
}

/** A 1ª rodada de verdade: o SQL que o CLI emite é o que o banco executa. */
function sqlEmitido(): string {
  const r = executar(['--sql-nuvem'], deps(mundoCom(EM_DIA)));
  expect(r.exit).toBe(0);
  expect(r.saida).toHaveLength(1);
  return r.saida[0];
}

function respostaPara(mundo: Mundo, o: { sqlExecutado?: string } = {}): string {
  return respostaDoBanco({
    sqlExecutado: o.sqlExecutado ?? sqlEmitido(),
    consumidor: CONSUMIDOR_NUVEM,
    registros: { sonda: mundo.sonda.map(registroDoBanco), detalhe: mundo.detalhe.map(registroDoBanco) },
    medidoEm: MEDIDO_EM,
  });
}

/** Os dois caminhos sobre a MESMA prod. */
function osDois(mundo: Mundo) {
  return {
    local: executar([], deps(mundo)),
    nuvem: executar(['--dados-nuvem=/resposta.json'], deps(mundo, respostaPara(mundo))),
  };
}

describe('deriva:corpo pela nuvem — o pacote cobre TODA leitura do psql-ro', () => {
  it('o que o caminho local manda ao psql é o envelope de transação em volta das consultas do pacote', () => {
    const d = deps(mundoCom(EM_DIA));
    expect(executar([], d).exit).toBe(0);
    expect(d.sqls).toHaveLength(1);
    const consultas = consultasDeriva(['f', 'g']);
    const miolo = d.sqls[0].split('\n').slice(1, -1).join('\n'); // sem o BEGIN e o COMMIT
    expect(d.sqls[0].split('\n')[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;');
    expect(d.sqls[0].split('\n').at(-1)).toBe('COMMIT;');
    expect(miolo).toBe([consultas.sonda, consultas.detalhe].join('\n'));
    expect(Object.keys(consultas).sort()).toEqual(['detalhe', 'sonda']);
  });

  it('--sql-nuvem imprime o SQL do transporte (as duas consultas) e sai 0 sem tocar o psql', () => {
    const d = deps(mundoCom(EM_DIA));
    const r = executar(['--sql-nuvem'], d);
    expect(r).toEqual({ exit: 0, saida: [gerarSqlNuvem(consultasDeriva(['f', 'g']), CONSUMIDOR_NUVEM)], erro: [] });
    expect(r.saida[0].startsWith('SET TRANSACTION READ ONLY;')).toBe(true);
    expect(d.sqls).toEqual([]);
  });

  it('no --sql-nuvem o aviso de entrada vai para o stderr: o stdout é SÓ o SQL copiado verbatim', () => {
    const d = deps(mundoCom(EM_DIA));
    const r = executar(['--sql-nuvem'], { ...d, carregarEntrada: (s, aviso) => (aviso('⚠️  entrada de TESTE'), d.carregarEntrada(s, aviso)) });
    expect(r.saida).toHaveLength(1);
    expect(r.saida[0].startsWith('SET TRANSACTION READ ONLY;')).toBe(true);
    expect(r.erro).toEqual(['⚠️  entrada de TESTE']);
  });
});

describe('deriva:corpo pela nuvem — o MESMO veredito do psql, byte a byte', () => {
  it('prod em dia: exit 0 nos dois, as mesmas linhas', () => {
    const { local, nuvem } = osDois(mundoCom(EM_DIA));
    expect(local.exit).toBe(0);
    expect(local.saida.at(-1)).toMatch(/^✅ deriva-corpo — 2 identidade\(s\) batem/);
    expect(nuvem).toEqual(local);
  });

  it('prod roda o corpo ANTERIOR de f(): exit 1 nos dois, com a mesma linha CORPO_ANTERIOR', () => {
    const { local, nuvem } = osDois(mundoCom([{ ...EM_DIA[0], corpo: ' SELECT 1 ' }, EM_DIA[1]]));
    expect(local.exit).toBe(1);
    expect(local.erro.join('\n')).toContain('[CORPO_ANTERIOR] f()');
    expect(nuvem).toEqual(local);
  });

  it('o detalhe sem o marcador de fim (resposta truncada no banco): exit 2 nos dois', () => {
    const { local, nuvem } = osDois(mundoCom(EM_DIA, { semFimDetalhe: true }));
    expect(local.exit).toBe(2);
    expect(local.erro.at(-1)).toMatch(/^⛔ deriva-corpo — medição INCOMPLETA/);
    expect(nuvem).toEqual(local);
  });
});

describe('deriva:corpo pela nuvem — o transporte recusa o que não é leitura desta rodada (exit 2)', () => {
  const mundo = mundoCom(EM_DIA);
  const nuvem = (arquivo: string) => executar(['--dados-nuvem', '/r.json'], deps(mundo, arquivo));

  it('TRANSPORTE_MD5: uma linha trocada na transcrição', () => {
    const r = nuvem(respostaPara(mundo).replace(md5Exato(' SELECT 3 '), md5Exato(' SELECT 9 ')));
    expect(r.exit).toBe(2);
    expect(r.erro[0]).toMatch(/^⛔ \[INCERTO\] transporte da nuvem: TRANSPORTE_MD5/);
  });

  it('TRANSPORTE_SQL_DIVERGENTE: a resposta é de outro SQL (a main mudou o conjunto de funções entre as rodadas)', () => {
    const outro = gerarSqlNuvem(consultasDeriva(['f', 'g', 'h']), CONSUMIDOR_NUVEM);
    const r = nuvem(respostaPara(mundo, { sqlExecutado: outro }));
    expect(r.exit).toBe(2);
    expect(r.erro[0]).toMatch(/^⛔ \[INCERTO\] transporte da nuvem: TRANSPORTE_SQL_DIVERGENTE/);
  });

  it('TRANSPORTE_ARQUIVO: sem a resposta não há veredito — nunca "tudo limpo"', () => {
    const r = executar(['--dados-nuvem=/nao/existe.json'], deps(mundo));
    expect(r.exit).toBe(2);
    expect(r.erro[0]).toMatch(/^⛔ \[INCERTO\] transporte da nuvem: TRANSPORTE_ARQUIVO/);
    expect(r.saida.some((l) => l.startsWith('✅'))).toBe(false);
  });

  it('argumento desconhecido e as duas metades juntas são mecânica (exit 2), não leitura', () => {
    expect(executar(['--sem_rede'], deps(mundo)).erro[0]).toMatch(/argumento desconhecido: --sem_rede/);
    expect(executar(['--sql-nuvem', '--dados-nuvem=/r.json'], deps(mundo)).exit).toBe(2);
  });
});
