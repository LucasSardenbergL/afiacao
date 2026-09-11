/**
 * Ponta a ponta: o CLI inteiro julga os intrusos do cron de sonda contra a allowlist da MAIN
 * RECÉM-BUSCADA — nunca contra o disco, nem contra uma `origin/main` que ninguém buscou.
 *
 * Harness trazido pela sessão `sharp-bohr-931460`, que atacou o mesmo defeito em paralelo e checou
 * este CLI de fora (2026-09-10). Os unitários de `pendencias-deploy.test.ts` injetam o leitor e a
 * allowlist; o que só aparece aqui é a BORDA: o `git fetch` de `lerEsperados` (sem ele, a allowlist
 * "da main" sai de uma ref velha e o incidente volta por outro caminho) e a fiação do `main()`.
 *
 * O cenário é montado de verdade, sem mock do CLI: um repo "remoto" cuja main anda para C2 DEPOIS
 * do clone, um clone parado em C1 (o `origin/main` dele diz C1 até alguém buscar), e um psql falso
 * que responde só às consultas que o CLI tem direito de fazer. O CLI roda como subprocesso, pelo
 * mesmo `bun` que o /fecho usa.
 *
 * O "disco" que o CLI compara é o `import` DESTE repo (a árvore do script), não o do clone — por
 * isso as edges do cenário saem de `DO_DISCO`. A allowlist de C1 só vira "a da main" se o fetch
 * for pulado: é ela que faz o fetch pulado reprovar.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SONDA_CRON_ALVOS } from '../supabase/functions/_shared/sonda-cron-alvos';
import {
  SQL,
  SQL_SAUDE_COLETOR,
  SQL_SAUDE_CRON_SONDA,
  SQL_SEM_IDENTIDADE,
  SQL_SONDA_CRON_ALVOS,
  SQL_SONDA_CRON_ATESTACOES,
  SQL_SONDA_CRON_DISPAROS,
  SQL_SONDA_CRON_MOTIVOS,
} from './pendencias-deploy';

const CLI = join(__dirname, 'pendencias-deploy.ts');
const FP = 'a'.repeat(64);
const EDGE_NOVA = 'edge-nova-na-main';
const DO_DISCO = SONDA_CRON_ALVOS.map((a) => a.edge);
/** Listada no disco real, em C1 e em C2: com o defeito OU sem ele, só é intrusa a que o teste plantar. */
const LEGITIMA = DO_DISCO[0];
/** Aprovada no disco real e ausente da main do cenário: o espelho do incidente. */
const SO_NO_DISCO = DO_DISCO[1];
const ORDEM_DE_ESCRITA = 'UPDATE public.deploy_sonda_alvos';

const criados: string[] = [];
afterEach(() => {
  for (const d of criados.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} falhou: ${r.stderr}`);
  return r.stdout.trim();
}

function escrever(raiz: string, arquivos: Record<string, string>): void {
  for (const [rel, texto] of Object.entries(arquivos)) {
    mkdirSync(dirname(join(raiz, rel)), { recursive: true });
    writeFileSync(join(raiz, rel), texto);
  }
}

/** A forma do arquivo real: tipo anotado, controle compartilhado por constante, comentário no meio. */
function allowlistTs(edges: string[]): string {
  return [
    'type AlvoSondaCron = { edge: string; desde: string | null; controles: readonly unknown[] };',
    'const CRON = { metodo: "POST", headers: { "x-cron-secret": "$CRON_SECRET" }, corpo: "{}", nota: "x" };',
    'export const SONDA_CRON_ALVOS: readonly AlvoSondaCron[] = [',
    '  // { edge: "comentada-nao-conta", desde: null, controles: [CRON] },',
    ...edges.map((e) => `  { edge: "${e}", desde: null, controles: [CRON] },`),
    '];',
    '',
  ].join('\n');
}

/** Um executável no papel do `psql-ro`: SQL que o cenário não previu = falha ALTA, nunca vazio. */
function psqlFalso(dir: string, ativosNoBanco: string[]): string {
  const respostas: Record<string, string> = {
    [SQL_SAUDE_COLETOR]: '5.0\n',
    [SQL]: `edge-a|v1.0-a|${FP}|sonda|2026-09-10 12:00Z|1.00\n`,
    [SQL_SEM_IDENTIDADE]: '',
    [SQL_SONDA_CRON_ALVOS]: ativosNoBanco.map((e) => `${e}\n`).join(''),
    [SQL_SAUDE_CRON_SONDA]: '30.0\n',
    [SQL_SONDA_CRON_DISPAROS]: '',
    [SQL_SONDA_CRON_ATESTACOES]: '',
    [SQL_SONDA_CRON_MOTIVOS]: '',
  };
  const arqRespostas = join(dir, 'respostas.json');
  writeFileSync(arqRespostas, JSON.stringify(respostas));
  const exe = join(dir, 'psql-falso');
  writeFileSync(
    exe,
    [
      '#!/usr/bin/env bun',
      "import { readFileSync } from 'node:fs';",
      `const respostas = JSON.parse(readFileSync(${JSON.stringify(arqRespostas)}, 'utf8'));`,
      'const sql = process.argv[process.argv.length - 1];',
      'if (!Object.hasOwn(respostas, sql)) {',
      "  console.error('psql-falso: SQL que o cenário não previu: ' + sql.slice(0, 160));",
      '  process.exit(3);',
      '}',
      'process.stdout.write(respostas[sql]);',
      '',
    ].join('\n'),
  );
  chmodSync(exe, 0o755);
  return exe;
}

/**
 * `remoto` é o GitHub: a main dele anda para C2 DEPOIS do clone. `local` é a worktree defasada,
 * clonada em C1 e nunca mais buscada — até o CLI buscar.
 */
function montarCenario(opts: {
  allowlistC1: string[];
  allowlistMain: string | string[];
  ativosNoBanco: string[];
}): { local: string; psql: string } {
  const base = mkdtempSync(join(tmpdir(), 'pendencias-allowlist-'));
  criados.push(base);
  const remoto = join(base, 'remoto');
  mkdirSync(remoto);
  git(remoto, 'init', '-q');
  git(remoto, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  escrever(remoto, {
    'supabase/functions/_shared/sonda-fingerprints.ts':
      `export const SONDA_FINGERPRINTS: Record<string, string> = {\n  "edge-a": "${FP}",\n};\n`,
    'supabase/functions/edge-a/versao.ts': 'export const VERSAO = "v1.0-a";\n',
    'supabase/functions/_shared/sonda-cron-alvos.ts': allowlistTs(opts.allowlistC1),
  });
  git(remoto, 'add', '-A');
  git(remoto, 'commit', '-q', '-m', 'C1: onde o clone para');

  const local = join(base, 'local');
  git(base, 'clone', '-q', remoto, local);

  escrever(remoto, {
    'supabase/functions/_shared/sonda-cron-alvos.ts':
      typeof opts.allowlistMain === 'string' ? opts.allowlistMain : allowlistTs(opts.allowlistMain),
  });
  git(remoto, 'commit', '-q', '--allow-empty', '-am', 'C2: a main anda depois do clone');

  return { local, psql: psqlFalso(base, opts.ativosNoBanco) };
}

function rodarCli(local: string, psql: string): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, PSQL_RO: psql };
  delete env.PENDENCIAS_TOLERAR_NUNCA_ATESTADA;
  const r = spawnSync('bun', [CLI], { cwd: local, encoding: 'utf8', env, timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('pendencias:deploy ponta a ponta — a allowlist que julga é a da main RECÉM-BUSCADA', () => {
  it('pré-condição: o cenário depende de edges que o disco real tem e de uma que ele NÃO tem', () => {
    expect(DO_DISCO.length).toBeGreaterThan(1);
    expect(DO_DISCO).not.toContain(EDGE_NOVA);
    expect(DO_DISCO).not.toContain('edge-intrusa');
  });

  it('o incidente: edge que a main e o banco têm, e o disco não conhece, NÃO vira intrusa', () => {
    const { local, psql } = montarCenario({
      allowlistC1: [LEGITIMA],
      allowlistMain: [LEGITIMA, EDGE_NOVA],
      ativosNoBanco: [LEGITIMA, EDGE_NOVA],
    });
    const r = rodarCli(local, psql);
    // Evidência POSITIVA de que o CLI chegou à seção e passou pelo ramo certo: sem ela, um crash
    // anterior também "não emitiria o UPDATE" e o teste passaria por cegueira. ASCII (lição #1483).
    expect(r.stdout).toContain('2 edge(s) ativa(s), 0 tick(s) recente(s)');
    expect(r.stdout).toContain('ALLOWLIST_DEFASADA');
    expect(r.stdout).toContain('1 commit(s)');
    expect(`${r.stdout}${r.stderr}`).not.toContain(ORDEM_DE_ESCRITA);
    expect(r.status).toBe(0);
  }, 60_000);

  it('o espelho: edge que SÓ o disco aprova e o banco ativou → exit 2 SEM a ordem de escrita', () => {
    const { local, psql } = montarCenario({
      allowlistC1: [LEGITIMA, SO_NO_DISCO],
      allowlistMain: [LEGITIMA],
      ativosNoBanco: [LEGITIMA, SO_NO_DISCO],
    });
    const r = rodarCli(local, psql);
    expect(r.stderr).toContain('ALVO_SO_NO_WORKTREE');
    expect(r.stderr).toContain(SO_NO_DISCO);
    expect(`${r.stdout}${r.stderr}`).not.toContain(ORDEM_DE_ESCRITA);
    expect(r.status).toBe(2);
  }, 60_000);

  it('controle positivo: intrusa de verdade (nem main, nem disco) sai COM a ordem — o harness enxerga o UPDATE', () => {
    const { local, psql } = montarCenario({
      allowlistC1: [LEGITIMA],
      allowlistMain: [LEGITIMA, EDGE_NOVA],
      ativosNoBanco: [LEGITIMA, 'edge-intrusa'],
    });
    const r = rodarCli(local, psql);
    expect(r.stderr).toContain('ALVO_SEM_APROVACAO');
    expect(r.stderr).toContain(`${ORDEM_DE_ESCRITA} SET ativo = false WHERE edge IN ('edge-intrusa');`);
    expect(r.status).toBe(2);
  }, 60_000);

  it('allowlist da main ILEGÍVEL: exit 2 de mecânica, e NENHUMA ordem de escrita', () => {
    // Spread é a forma de um refactor futuro que o leitor não segue. Sem lista confiável não há
    // intruso a julgar — e ordem de escrita em prod a partir de leitura parcial é o defeito.
    const ilegivel = [
      `const ONDA_1 = [{ edge: "${LEGITIMA}", desde: null, controles: [] }];`,
      'export const SONDA_CRON_ALVOS = [...ONDA_1];',
      '',
    ].join('\n');
    const { local, psql } = montarCenario({
      allowlistC1: [LEGITIMA],
      allowlistMain: ilegivel,
      ativosNoBanco: [LEGITIMA, EDGE_NOVA],
    });
    const r = rodarCli(local, psql);
    expect(r.stderr).toContain('ALLOWLIST_ILEGIVEL');
    expect(`${r.stdout}${r.stderr}`).not.toContain(ORDEM_DE_ESCRITA);
    expect(r.status).toBe(2);
  }, 60_000);
});
