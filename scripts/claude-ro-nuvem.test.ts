/**
 * `authz:claude-ro:prod` pela NUVEM (`--sql-nuvem` / `--dados-nuvem`) — o MESMO veredito do `psql-ro`.
 *
 * O mundo de prod sintético sai do próprio `BASELINE_PROD`: o catálogo íntegro é a linha que cada
 * asserção espera, e cada mundo sabota UM eixo. Das MESMAS linhas sai o texto do psql falso e o
 * payload montado como o banco montaria (`lib/transporte-nuvem-fixture.ts`). As sondas executivas
 * chegam pelos dois canais na forma de cada um: no local, o stderr VERBOSO do psql (lido por
 * `erroDoPsql`); na nuvem, o desfecho do preâmbulo (`ERRO|<sqlstate>|<SQLERRM>`). Veredito igual
 * byte a byte é o transporte não virando outro juiz. A prova num Postgres de verdade — o SQL da
 * nuvem rodado por um papel-canal — é o cenário (V) de `db/test-audit-claude-ro-hardening.sh`.
 */
import { describe, expect, it } from 'vitest';

import {
  BASELINE_PROD,
  consultasNuvem,
  CONSUMIDOR_NUVEM,
  type Dependencias,
  erroDoPsql,
  executar,
  montarQuery,
  sondasNuvem,
} from '../db/audit-claude-ro-hardening';

import { gerarSqlNuvem } from './lib/transporte-nuvem';
import { registroDoBanco, respostaDoBanco } from './lib/transporte-nuvem-fixture';

const AGORA = new Date('2026-10-01T12:00:00Z');
const B = BASELINE_PROD;

/** O catálogo que a query devolveria com prod IGUAL ao baseline — uma linha `ROW|…` por asserção. */
function catalogoIntegro(): string[] {
  const net = B.netAcl.map((e) => {
    const [tipo, ...meio] = e.split('|');
    return `ROW|NETACL|${meio.join('|')}|${tipo}`;
  });
  return [
    'ROW|PAPEL|existe|SIM',
    `ROW|PAPEL|rolattrs|${B.rolattrs}`,
    `ROW|PAPEL|memberships|${B.memberships}`,
    `ROW|PAPEL|guc|${B.guc}`,
    'ROW|PAPEL|guc_fonte|db_role_setting',
    ...B.schemasComAlcance.map((s) => `ROW|SCHEMA|${s}|SIM`),
    ...B.schemasSemAlcance.map((s) => `ROW|SCHEMA|${s}|NAO`),
    ...B.tabelasLegiveis.map((t) => `ROW|TABELA|${t}|SIM`),
    ...B.schemasCobertura.map((s) => `ROW|COBERTURA|${s}|413|0`),
    'ROW|PONTE|reloptions|security_invoker=on',
    ...B.ponte.colunas.map((c) => `ROW|PONTECOL|${c}`),
    ...B.authColAcl.entradas.map((e) => `ROW|AUTHCOL|${e}`),
    ...B.membros.map((m) => `ROW|MEMBRO|${m}`),
    ...net,
    `ROW|PGNET|version|${B.pgNetVersion}`,
  ];
}

/** O desfecho de uma sonda: o erro como o SERVIDOR o diz (SQLSTATE + mensagem) ou a sonda que rodou. */
type Desfecho = { erro: string; mensagem: string } | { rodou: string };

/** As 3 negadas e a permitida, na ordem do baseline, como prod responde hoje. */
const SONDAS_OK: Desfecho[] = [
  { erro: '42501', mensagem: 'permission denied for schema auth' },
  { erro: '42501', mensagem: 'permission denied for schema vault' },
  { erro: '42703', mensagem: 'column "token" does not exist' },
  { rodou: '404' },
];

interface Mundo {
  catalogo: string[];
  sondas: Desfecho[];
}
const INTEGRO: Mundo = { catalogo: catalogoIntegro(), sondas: SONDAS_OK };
const SQL_SONDAS = [...B.sondasNegadas, ...B.sondasPermitidas].map((s) => s.sql);

/** O stderr do `psql -v VERBOSITY=verbose -tA -c` quando o servidor recusa a consulta. */
const stderrDoPsql = (sqlstate: string, mensagem: string, sql: string) =>
  `ERROR:  ${sqlstate}: ${mensagem}\nLINE 1: ${sql}\n                     ^\nLOCATION:  aclcheck_error, aclchk.c:2843\n`;

/** O mundo injetado no caminho LOCAL: o psql falso (com o eco de `SET` do psqlrc) e as sondas. */
function depsLocal(mundo: Mundo): Dependencias & { sqls: string[] } {
  const sqls: string[] = [];
  return {
    sqls,
    baselineDeTeste: undefined,
    psql: (sql) => {
      sqls.push(sql);
      return `SET\nSET\n${mundo.catalogo.join('\n')}\n`;
    },
    sonda: (sql) => {
      sqls.push(sql);
      const d = mundo.sondas[SQL_SONDAS.indexOf(sql)];
      if (d === undefined) throw new Error(`sonda fora do mundo: ${sql}`);
      if ('rodou' in d) return { tipo: 'rodou', valor: `${d.rodou}` };
      // O caminho real: o texto verboso do psql, lido pela MESMA função que o runner usa.
      return { tipo: 'erro', ...erroDoPsql(stderrDoPsql(d.erro, d.mensagem, sql)) };
    },
    lerArquivo: () => {
      throw new Error('o caminho local não lê arquivo');
    },
    agora: () => AGORA,
  };
}

/** A 1ª rodada de verdade: o SQL que o CLI emite é o que o banco executa. */
function sqlEmitido(): string {
  const r = executar(['--sql-nuvem'], depsLocal(INTEGRO));
  expect(r.exit).toBe(0);
  return r.saida[0];
}

/** O desfecho como o preâmbulo o deixa no GUC (`papel` = o SET ROLE negado, antes de a sonda rodar). */
function desfechoDoBanco(d: Desfecho | 'papel'): string {
  if (d === 'papel') return 'PAPEL|42501|permission denied to set role "claude_ro"';
  return 'rodou' in d ? `RODOU|${d.rodou}` : `ERRO|${d.erro}|${d.mensagem}`;
}

function respostaPara(mundo: Mundo, o: { papelNegado?: boolean } = {}): string {
  const nomes = Object.keys(sondasNuvem(B).sondas); // negada_1…3, permitida_1 — a ordem do baseline
  const registros: Record<string, string[]> = { catalogo: mundo.catalogo.map((l) => registroDoBanco([l])) };
  nomes.forEach((n, i) => {
    registros[`sonda__${n}`] = [registroDoBanco([desfechoDoBanco(o.papelNegado ? 'papel' : mundo.sondas[i])])];
  });
  return respostaDoBanco({ sqlExecutado: sqlEmitido(), consumidor: CONSUMIDOR_NUVEM, registros, medidoEm: '2026-10-01T11:59:00Z' });
}

function osDois(mundo: Mundo) {
  return {
    local: executar([], depsLocal(mundo)),
    nuvem: executar(['--dados-nuvem=/r.json'], { ...depsLocal(mundo), lerArquivo: () => respostaPara(mundo) }),
  };
}

const comCatalogo = (troca: (linhas: string[]) => string[]): Mundo => ({ ...INTEGRO, catalogo: troca(catalogoIntegro()) });
const comSonda = (i: number, d: Desfecho): Mundo => ({ ...INTEGRO, sondas: SONDAS_OK.map((s, j) => (j === i ? d : s)) });

describe('claude-ro pela nuvem — o pacote cobre TODA leitura do psql-ro', () => {
  it('todo SQL que o caminho local manda ao psql está no pacote: o catálogo como consulta, as sondas no preâmbulo', () => {
    const d = depsLocal(INTEGRO);
    expect(executar([], d).exit).toBe(0);
    const noPacote = new Set([...Object.values(consultasNuvem(B)), ...Object.values(sondasNuvem(B).sondas).map((s) => s.sql)]);
    expect(d.sqls.filter((sql) => !noPacote.has(sql))).toEqual([]);
    // e o pacote não traz leitura que o local não faz
    expect(new Set(d.sqls)).toEqual(noPacote);
  });

  it('as sondas rodam COMO claude_ro, e só a permitida devolve valor (a da vault nunca traz o segredo)', () => {
    const s = sondasNuvem(B);
    expect(s.papel).toBe('claude_ro');
    expect(Object.entries(s.sondas).filter(([, v]) => v.devolverValor).map(([n]) => n)).toEqual(['permitida_1']);
    expect(s.sondas.negada_2.sql).toContain('vault.decrypted_secrets');
  });

  it('--sql-nuvem imprime o SQL do transporte e sai 0 sem tocar o psql', () => {
    const d = depsLocal(INTEGRO);
    const r = executar(['--sql-nuvem'], d);
    expect(r).toEqual({ exit: 0, saida: [gerarSqlNuvem(consultasNuvem(B), CONSUMIDOR_NUVEM, sondasNuvem(B))], erro: [] });
    expect(d.sqls).toEqual([]);
    expect(montarQuery(B)).not.toMatch(/;\s*\S/); // nenhum `;` no meio — nem em comentário
  });
});

describe('claude-ro pela nuvem — o MESMO veredito do psql, byte a byte', () => {
  it('prod igual ao baseline: exit 0 nos dois, as mesmas linhas', () => {
    const { local, nuvem } = osDois(INTEGRO);
    expect(local.exit).toBe(0);
    expect(local.saida.at(-1)).toMatch(/O endurecimento continua de pé/);
    expect(local.saida).toContain('  ✅ sonda + ponte de telemetria: alcançável (404)');
    expect(nuvem).toEqual(local);
  });

  it('alguém NOVO pode virar o papel (GRANT claude_ro TO authenticated): exit 1 nos dois', () => {
    const { local, nuvem } = osDois(comCatalogo((l) => [...l, 'ROW|MEMBRO|authenticated|admin=nao,inherit=sim,set=sim|postgres']));
    expect(local.exit).toBe(1);
    expect(local.erro.join('\n')).toContain('+ authenticated|admin=nao,inherit=sim,set=sim|postgres');
    expect(nuvem).toEqual(local);
  });

  it('auth reaberto: a sonda negada RODA — exit 1 nos dois, "consulta teve SUCESSO"', () => {
    const { local, nuvem } = osDois(comSonda(0, { rodou: '8' }));
    expect(local.exit).toBe(1);
    expect(local.erro.join('\n')).toContain('consulta teve SUCESSO');
    expect(nuvem).toEqual(local);
  });

  it('a ponte projeta token: a sonda 42703 falha com OUTRO erro — o mesmo detalhe pelos dois canais', () => {
    const { local, nuvem } = osDois(comSonda(2, { erro: '42501', mensagem: 'permission denied for table refresh_tokens' }));
    expect(local.exit).toBe(1);
    expect(local.erro.join('\n')).toContain('falhou SEM 42703 (outro erro): 42501: permission denied for table refresh_tokens');
    expect(nuvem).toEqual(local);
  });

  it('a ponte deixou de ser legível: a sonda permitida falha — exit 1, "o alcance caiu"', () => {
    const { local, nuvem } = osDois(comSonda(3, { erro: '42501', mensagem: 'permission denied for view auth_refresh_tokens_diag' }));
    expect(local.exit).toBe(1);
    expect(local.erro.join('\n')).toContain('o alcance caiu: 42501: permission denied for view auth_refresh_tokens_diag');
    expect(nuvem).toEqual(local);
  });

  it('catálogo truncado: exit 2 nos dois ("medição inconsistente") — medição quebrada não é aprovação', () => {
    const { local, nuvem } = osDois(comCatalogo((l) => l.slice(0, 10)));
    expect(local.exit).toBe(2);
    expect(local.erro[0]).toMatch(/^❌ medição inconsistente/);
    expect(nuvem).toEqual(local);
  });
});

describe('claude-ro pela nuvem — o que só a nuvem pode errar sai 2, nunca 0', () => {
  it('o conector SEM SET em claude_ro: TRANSPORTE_SONDA_PAPEL, com o GRANT que falta — nunca "negado com 42501"', () => {
    const r = executar(['--dados-nuvem=/r.json'], { ...depsLocal(INTEGRO), lerArquivo: () => respostaPara(INTEGRO, { papelNegado: true }) });
    expect(r.exit).toBe(2);
    expect(r.erro[0]).toMatch(/^❌ transporte da nuvem: TRANSPORTE_SONDA_PAPEL/);
    expect(r.erro[0]).toContain('GRANT claude_ro TO postgres WITH INHERIT FALSE, SET TRUE;');
    expect(r.saida.some((l) => l.includes('negado com'))).toBe(false);
  });

  it('baseline de teste sem `membros`: exit 2 — contrato incompleto não é "nada a conferir"', () => {
    const semMembros = JSON.stringify({ ...B, membros: undefined });
    const r = executar([], { ...depsLocal(INTEGRO), baselineDeTeste: semMembros });
    expect(r.exit).toBe(2);
    expect(r.erro[0]).toContain("sem o campo 'membros'");
  });

  it('argumento desconhecido é mecânica (exit 2)', () => {
    expect(executar(['--sql_nuvem'], depsLocal(INTEGRO)).erro[0]).toMatch(/argumento desconhecido: --sql_nuvem/);
  });
});

describe('erroDoPsql — a SQLSTATE do erro verboso, em qualquer locale do servidor', () => {
  it.each([
    ['ERROR:  42501: permission denied for schema auth\nLINE 1: SELECT 1\n', '42501', 'permission denied for schema auth'],
    ['ERRO:  42501: permissão negada para esquema auth\nLINHA 1: SELECT 1\n', '42501', 'permissão negada para esquema auth'],
    ['psql:<stdin>:1: ERROR:  42703: column "token" does not exist\n', '42703', 'column "token" does not exist'],
  ])('%j', (texto, sqlstate, mensagem) => {
    expect(erroDoPsql(texto)).toEqual({ sqlstate, mensagem });
  });

  it('sem SQLSTATE (o cliente falando — conexão caída) fica o texto, nunca uma SQLSTATE inventada', () => {
    expect(erroDoPsql('psql: error: connection to server failed\n')).toEqual({
      sqlstate: '',
      mensagem: 'psql: error: connection to server failed',
    });
  });
});
