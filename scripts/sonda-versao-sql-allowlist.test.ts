/**
 * O guard do bloco legado do `sonda:sql` julga pela allowlist do cron de `origin/main` — nunca pela
 * do DISCO (incidente de 2026-09-10; a classe do #2464, `docs/historico/sonda-le-worktree-defasado.md`).
 *
 * O defeito morava na FIAÇÃO: a borda da CLI entregava ao `main` o `import` de `SONDA_CRON_ALVOS` do
 * disco, e nenhum teste chamava o `main` com a allowlist — o `guardEfeitoLegado` só era testado
 * sozinho, com uma lista fixa. Num worktree atrás da main, uma edge que a main já pusera no relé
 * (`omie-desconto-backfill`, que ESCREVE) escapava da recusa e o bloco legado saía sem aviso. Por
 * isso aqui tudo passa pelo `main` inteiro, com o kit REAL da lib e um `git` que responde a ref.
 *
 * Arquivo PRÓPRIO, e pequeno, de propósito: é o `@test` do contrato
 * `scripts/mutcheck.d/sonda-versao-sql-allowlist-ref.mut`, e cada mutante roda o arquivo inteiro.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { removerComentarios } from '@/lib/gates/limpeza-fonte';

import * as kit from './lib/sonda-cron-allowlist';
import { fontesDoEsperado, main, resolverLeva, type ExecutorGit } from './sonda-versao-sql';

const criadas: string[] = [];
afterEach(() => {
  for (const d of criadas.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A edge do incidente: na allowlist da main desde a onda 5, e uma edge que ESCREVE. */
const DA_MAIN = 'omie-desconto-backfill';
/** Aprovada só no worktree — uma entrega ainda não mergeada. */
const EM_VOO = 'edge-em-voo';
/** Nas duas listas. */
const COMUM = 'monthly-report';
/** Em nenhuma: o caso comum, que tem de continuar silencioso. */
const SEM_RELE = 'omie-sync-estoque';

/** A forma do arquivo real: tipo anotado, e um comentário que CITA um slug sem aprová-lo. */
function allowlistTs(edges: string[]): string {
  return [
    'type AlvoSondaCron = { edge: string; desde: string | null };',
    `// a nota da onda 5 cita "${EM_VOO}" — comentário não aprova ninguém`,
    'export const SONDA_CRON_ALVOS: readonly AlvoSondaCron[] = [',
    ...edges.map((e) => `  { edge: "${e}", desde: null },`),
    '];',
    '',
  ].join('\n');
}

/**
 * Repo de mentira: `versao.ts` e fingerprint de cada edge da leva, e a allowlist do DISCO (`null` =
 * o arquivo não existe no worktree). É a mesma forma que `resolverLeva` exige do repo de verdade.
 */
function repo(leva: string[], allowlistDoDisco: string[] | null): string {
  const raiz = mkdtempSync(join(tmpdir(), 'sonda-sql-allowlist-'));
  criadas.push(raiz);
  const funcoes = join(raiz, 'supabase', 'functions');
  mkdirSync(join(funcoes, '_shared'), { recursive: true });
  writeFileSync(join(raiz, 'supabase', 'config.toml'), 'project_id = "refdementira000000ab"\n');
  const mapa: string[] = [];
  for (const edge of leva) {
    mkdirSync(join(funcoes, edge), { recursive: true });
    writeFileSync(
      join(funcoes, edge, 'versao.ts'),
      `export { classificarSonda } from "../_shared/sonda-versao.ts";\nexport const VERSAO = "v1.0-${edge}";\n`,
    );
    const fp = createHash('sha256').update(edge).digest('hex');
    mapa.push(`  ${JSON.stringify(edge)}: ${JSON.stringify(fp)},`);
  }
  writeFileSync(
    join(funcoes, '_shared', 'sonda-fingerprints.ts'),
    `export const FONTE_SHA256: Record<string, string> = {\n${mapa.join('\n')}\n};\n`,
  );
  if (allowlistDoDisco !== null) writeFileSync(join(raiz, kit.ARQ_ALLOWLIST), allowlistTs(allowlistDoDisco));
  return raiz;
}

/** O `rev-list` que o diagnóstico da defasagem pede — só ESTE, na ordem certa, recebe resposta. */
const REV_LIST = ['rev-list', '--left-right', '--count', 'HEAD...origin/main'];

/**
 * `git` fabricado. A `origin/main` tem a fatia do `esperado(...)` EM DIA com o disco — o defeito não
 * depende da fatia: ele aparece justamente com ela sincronizada — e a allowlist que o cenário mandar
 * (`null` = o arquivo não existe na ref; `'ilegivel'` = texto cortado). Só a ref `origin/main`
 * responde: ler de qualquer outra (`HEAD`, a cópia commitada do disco) cai no "não existe".
 */
function gitDaMain(
  raiz: string,
  leva: string[],
  opts: { allowlist: string[] | null | 'ilegivel'; revList?: string; fetchFalha?: boolean; chamadas?: string[][] },
): ExecutorGit {
  const fatia = new Map(fontesDoEsperado(resolverLeva(raiz, leva)).map((f) => [f.caminho, f.bytes]));
  return (args) => {
    opts.chamadas?.push(args);
    if (args[0] === 'fetch') {
      return opts.fetchFalha === true
        ? { status: 128, stdout: '', stderr: 'fatal: unable to access ...: Could not resolve host' }
        : { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'abc123def4567890\n', stderr: '' };
    if (args[0] === 'log') return { status: 0, stdout: '2026-09-01 10:00:00 +0000\n', stderr: '' };
    if (args.join(' ') === REV_LIST.join(' ') && opts.revList !== undefined) {
      return { status: 0, stdout: opts.revList, stderr: '' };
    }
    // Corta no PRIMEIRO `:`, não num prefixo fixo: TODA leitura da ref — as fontes da fatia e a
    // allowlist — sai do COMMIT resolvido, porque `origin/main` pode andar no meio da execução.
    // Espelho ancorado em `origin/main:` não responderia nenhuma, e o guard abortaria por fonte
    // "ausente" — teste medindo a fixture.
    if (args[0] === 'show' && args[1].includes(':')) {
      const caminho = args[1].slice(args[1].indexOf(':') + 1);
      let conteudo: string | undefined = fatia.get(caminho);
      if (caminho === kit.ARQ_ALLOWLIST && opts.allowlist !== null) {
        const inteiro = allowlistTs(opts.allowlist === 'ilegivel' ? [COMUM, DA_MAIN] : opts.allowlist);
        conteudo = opts.allowlist === 'ilegivel' ? inteiro.slice(0, inteiro.indexOf(DA_MAIN)) : inteiro;
      }
      if (conteudo !== undefined) return { status: 0, stdout: conteudo, stderr: '' };
    }
    return { status: 128, stdout: '', stderr: `fatal: invalid object name '${args[1] ?? args[0]}'` };
  };
}

function rodar(raiz: string, argv: string[], git: ExecutorGit) {
  const saida: string[] = [];
  const erros: string[] = [];
  const codigo = main(argv, { raiz, escrever: (t) => saida.push(t), erro: (t) => erros.push(t), git, allowlist: kit });
  return { codigo, saida: saida.join(''), erros: erros.join('\n') };
}

/**
 * Onde, na lista de chamadas, o `git show` da allowlist aconteceu (-1 = nunca).
 *
 * Casa pelo SUFIXO porque o alvo é `<sha>:<arquivo>`, nunca mais `origin/main:<arquivo>` (#2871).
 * De que commit ele sai é asserção de `sonda-versao-sql.test.ts` ("todo `show` DA EXECUÇÃO"); aqui
 * o que importa é a ORDEM — depois do fetch, e nunca quando o fetch falhou.
 */
const indiceDoShowDaAllowlist = (chamadas: string[][]) =>
  chamadas.findIndex((c) => c[0] === 'show' && c[1].endsWith(`:${kit.ARQ_ALLOWLIST}`));

describe('o guard do bloco legado julga pela allowlist da REF, não pela do disco', () => {
  it('(a) edge na allowlist da main e FORA da do disco (worktree atrás) → RECUSADO, nada emitido', () => {
    const raiz = repo([DA_MAIN], [COMUM]);
    const r = rodar(raiz, [DA_MAIN], gitDaMain(raiz, [DA_MAIN], { allowlist: [COMUM, DA_MAIN], revList: '0\t10\n' }));
    expect(r.codigo).toBe(1);
    expect(r.saida).toBe('');
    expect(r.erros).toContain('RECUSADO:');
    expect(r.erros).toContain(`deploy_sonda_disparar(ARRAY['${DA_MAIN}'])`);
    // e a defasagem é NOMEADA — é ela que explica a recusa que o disco do operador não previa
    expect(r.erros).toContain('ALLOWLIST_DEFASADA');
    expect(r.erros).toContain(`na main: ${DA_MAIN}`);
    expect(r.erros).toContain('10 commit(s)');
    expect(r.erros).toContain('sincronize antes de medir');
  });

  it('(b) edge FORA da allowlist da main, mesmo DENTRO da do disco → não recusa; o SQL sai e o topo diz por quê', () => {
    const raiz = repo([EM_VOO], [COMUM, EM_VOO]);
    const r = rodar(raiz, [EM_VOO], gitDaMain(raiz, [EM_VOO], { allowlist: [COMUM], revList: '2\t0\n' }));
    expect(r.codigo).toBe(0);
    expect(r.erros).not.toContain('RECUSADO');
    expect(r.saida).toContain(`('${EM_VOO}', 'v1.0-${EM_VOO}'`);
    // A divergência MUDOU o que foi emitido (pela main a edge não tem relé) — sobe para o SQL, que é
    // o artefato que quem cola lê; o stderr some.
    expect(r.saida.startsWith('-- ⚠️ ALLOWLIST_DEFASADA')).toBe(true);
    expect(r.saida).toContain(`no seu worktree: ${EM_VOO}`);
    expect(r.saida).toContain('2 commit(s)');
    expect(r.saida).toContain(`Nesta leva, aprovada(s) s`);
  });

  it('edge nas DUAS listas → RECUSADO (o conserto não pode afrouxar o caso sincronizado)', () => {
    const raiz = repo([COMUM], [COMUM]);
    const r = rodar(raiz, [COMUM], gitDaMain(raiz, [COMUM], { allowlist: [COMUM] }));
    expect(r.codigo).toBe(1);
    expect(r.erros).toContain('RECUSADO:');
    expect(r.erros).not.toContain('ALLOWLIST_DEFASADA');
  });

  it('edge em NENHUMA lista → SQL sem aviso: o caso comum continua silencioso', () => {
    const raiz = repo([SEM_RELE], [COMUM]);
    const r = rodar(raiz, [SEM_RELE], gitDaMain(raiz, [SEM_RELE], { allowlist: [COMUM] }));
    expect(r.codigo).toBe(0);
    expect(r.erros).toBe('');
    expect(r.saida).toContain(`('${SEM_RELE}', 'v1.0-${SEM_RELE}'`);
    expect(r.saida).not.toContain('ALLOWLIST');
  });

  it('divergência FORA da leva → aviso no stderr, e o SQL sai limpo (não mudou o que foi emitido)', () => {
    const raiz = repo([SEM_RELE], [COMUM]);
    const r = rodar(raiz, [SEM_RELE], gitDaMain(raiz, [SEM_RELE], { allowlist: [COMUM, DA_MAIN], revList: '0\t4\n' }));
    expect(r.codigo).toBe(0);
    expect(r.erros).toContain('ALLOWLIST_DEFASADA');
    expect(r.erros).toContain('4 commit(s)');
    expect(r.saida).not.toContain('ALLOWLIST');
  });

  it('--permitir-efeito-legado continua sendo a ÚNICA forma de liberar edge da allowlist da main', () => {
    const raiz = repo([DA_MAIN], [COMUM]);
    const r = rodar(
      raiz,
      [DA_MAIN, '--permitir-efeito-legado'],
      gitDaMain(raiz, [DA_MAIN], { allowlist: [COMUM, DA_MAIN], revList: '0\t10\n' }),
    );
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain(`('${DA_MAIN}', 'v1.0-${DA_MAIN}'`);
  });
});

describe('ler a allowlist da ref: ausente ≠ vazia', () => {
  it('`git show` da allowlist falha → ALLOWLIST_ILEGIVEL, nada emitido — nunca "nenhuma tem relé"', () => {
    // A edge está na lista do DISCO: se a falha virasse lista vazia, o guard a deixaria passar; se
    // virasse "cai para o disco", sairia RECUSADO. Só a mecânica nomeada é a resposta certa.
    const raiz = repo([DA_MAIN], [DA_MAIN]);
    const r = rodar(raiz, [DA_MAIN], gitDaMain(raiz, [DA_MAIN], { allowlist: null }));
    expect(r.codigo).toBe(1);
    expect(r.saida).toBe('');
    expect(r.erros).toContain('ALLOWLIST_ILEGIVEL');
    expect(r.erros).toContain(`git show origin/main:${kit.ARQ_ALLOWLIST}`);
    expect(r.erros).not.toContain('RECUSADO');
  });

  it('texto da ref que o parser não lê → ALLOWLIST_ILEGIVEL, com o diagnóstico do worktree ao lado', () => {
    const raiz = repo([SEM_RELE], [COMUM]);
    const r = rodar(raiz, [SEM_RELE], gitDaMain(raiz, [SEM_RELE], { allowlist: 'ilegivel', revList: '0\t3\n' }));
    expect(r.codigo).toBe(1);
    expect(r.saida).toBe('');
    expect(r.erros).toContain('ALLOWLIST_ILEGIVEL');
    expect(r.erros).toContain('parseia');
    expect(r.erros).toContain('3 commit(s)');
  });

  it('allowlist do DISCO ilegível → o guard segue a ref, e a saída diz que não leu o disco', () => {
    const raiz = repo([SEM_RELE], null);
    const r = rodar(raiz, [SEM_RELE], gitDaMain(raiz, [SEM_RELE], { allowlist: [COMUM] }));
    expect(r.codigo).toBe(0);
    expect(r.erros).toContain('ALLOWLIST_DO_DISCO_ILEGIVEL');
    expect(r.saida).not.toContain('ALLOWLIST');
  });
});

describe('um fetch, uma ref: a allowlist e a fatia leem a MESMA origin/main', () => {
  it('o fetch acontece UMA vez, e ANTES de a allowlist ser lida', () => {
    const raiz = repo([SEM_RELE], [COMUM]);
    const chamadas: string[][] = [];
    const r = rodar(raiz, [SEM_RELE], gitDaMain(raiz, [SEM_RELE], { allowlist: [COMUM], chamadas }));
    expect(r.codigo).toBe(0);
    const fetches = chamadas.flatMap((c, i) => (c[0] === 'fetch' ? [i] : []));
    expect(fetches).toEqual([0]);
    expect(indiceDoShowDaAllowlist(chamadas)).toBeGreaterThan(0);
  });

  it('fetch que falha → aborta ANTES de ler a allowlist: retrato velho não decide a recusa', () => {
    const raiz = repo([DA_MAIN], [COMUM]);
    const chamadas: string[][] = [];
    const r = rodar(raiz, [DA_MAIN], gitDaMain(raiz, [DA_MAIN], { allowlist: [COMUM, DA_MAIN], fetchFalha: true, chamadas }));
    expect(r.codigo).toBe(1);
    expect(r.saida).toBe('');
    expect(r.erros).toContain('--sem-rede');
    expect(indiceDoShowDaAllowlist(chamadas)).toBe(-1);
  });

  it('--sem-rede: nenhum fetch, e a allowlist sai da origin/main que está em disco', () => {
    const raiz = repo([DA_MAIN], [COMUM]);
    const chamadas: string[][] = [];
    const r = rodar(raiz, [DA_MAIN, '--sem-rede'], gitDaMain(raiz, [DA_MAIN], { allowlist: [COMUM, DA_MAIN], chamadas }));
    expect(chamadas.some((c) => c[0] === 'fetch')).toBe(false);
    expect(r.codigo).toBe(1);
    expect(r.erros).toContain('RECUSADO:');
  });
});

describe('a borda da CLI entrega o PARSER, nunca a lista', () => {
  const FONTE = join(import.meta.dirname, 'sonda-versao-sql.ts');

  it('o código não importa mais a allowlist do disco — nem de topo, nem dinâmico', () => {
    const cru = readFileSync(FONTE, 'utf8');
    const codigo = removerComentarios(cru);
    // o stripper deixou código de sobra (gate que mede string vazia é gate cego)
    expect(codigo.length).toBeGreaterThan(cru.length * 0.4);
    expect(codigo).toContain("await import('./lib/sonda-cron-allowlist')");
    expect(codigo).not.toContain('sonda-cron-alvos');
    expect(codigo).not.toContain('SONDA_CRON_ALVOS');
  });

  it('a CLI de verdade carrega a lib e chega ao main — sem argumento, o erro é o do parse', () => {
    const r = spawnSync('bun', [FONTE], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('nenhuma edge na leva');
  });
});
