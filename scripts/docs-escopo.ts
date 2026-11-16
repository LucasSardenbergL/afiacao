/**
 * Escopo SÓ-DOCS do PR: decide se os 8 jobs não-SQL do `ci.yml` podem ceder lugar ao `docs-gates`.
 *
 * Medido em 28/10–11/11/2026 (docs/historico/ci-escopo-so-docs.md): 133 de 400 PRs mergeados eram só
 * de `docs/`, e cada run deles pagava ~2.400 s de runner e 264–434 s de caminho crítico em jobs que
 * não leem `docs/` — com exceção de 5 gates e 6 arquivos vitest, que o `docs-gates` roda.
 *
 * Dois modos, ambos FAIL-CLOSED:
 *
 *  - `--evento <nome>` (job `docs-escopo` e step `escopo` de cada parte do `docs-gates`): escreve
 *    `so_docs=true` em `$GITHUB_OUTPUT` SÓ se o evento é `pull_request`, o HEAD é o merge sintético
 *    (2 pais), o `git diff -z` do pai 1 ao HEAD terminou 0, é não-vazio, e TODO caminho casa `^docs/.+\.md$`. Qualquer outra coisa (evento da main, erro de
 *    git, diff vazio, `.mjs`/`.sql`/`.sh` em `docs/`, `CLAUDE.md` na raiz) escreve `false` — e os 8
 *    jobs rodam. Nunca sai ≠ 0 por decisão; só se não conseguir ESCREVER a saída (aí o job falha e os
 *    pesados rodam pelo `if`, que exige `result == success`).
 *
 *  - `--testes` (job `docs-gates`): roda o vitest sobre o SUPERCONJUNTO dos testes que podem ler
 *    `docs/`: todo arquivo do universo do vitest cujo texto cita `docs`, `CLAUDE.md` ou `README.md`,
 *    UNIDO aos leitores conhecidos (`LEITORES_DE_DOCS`), que precisam existir — sumiu um, reprova.
 *    O filtro textual é heurística, não análise de dependência: a rede é o CI da main, que roda os 8
 *    jobs inteiros a cada merge (mesma postura do `provas-sql-escopo`, docs/historico/ci-provas-sql-escopo.md).
 *
 *    Com `--parte i/N` (os N jobs da matriz do `docs-gates`, 2026-11-16) roda só a parte `i` de uma
 *    partição DETERMINÍSTICA da mesma seleção (`particionar`: maior arquivo primeiro, para a parte
 *    mais leve; peso = `PESO_SEGUNDOS`). As N partes são disjuntas e a união é a seleção inteira — o
 *    `docs-escopo.test.ts` prova isso na árvore real. Parte vazia ou fora de 1..N reprova.
 *
 * Step OPACO de propósito (`bun ./scripts/…`): o escopo não é gate, e os testes que o `--testes` roda
 * já são gate no job `testes` — não entram duas vezes no censo nem na matriz da exclusividade.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { mensagemDeErro } from '@/lib/erro-mensagem';

/** Allowlist do que um PR só-docs pode tocar. Estreita de propósito: só Markdown sob `docs/`. */
export const RE_DOC = /^docs\/.+\.md$/;

/**
 * Testes que LEEM `docs/` ou `CLAUDE.md` em runtime (mapa de 2026-11-11). Entram mesmo se o filtro
 * textual deixar de casá-los — o `authz-carimbo` monta o caminho com `join(RAIZ, 'docs', …)`.
 */
export const LEITORES_DE_DOCS: readonly string[] = [
  'src/__tests__/edge-money-path-invariants.test.ts',
  'scripts/lib/prompt-deploy.test.ts',
  'scripts/docs-citacoes-gate-check.test.ts',
  'scripts/docs-indice-gate-check.test.ts',
  'scripts/authz-carimbo.test.ts',
  'scripts/exclusividade-gate.test.ts',
];

/** O universo do vitest (`vitest.config.ts`: `src/**\/*.{test,spec}.{ts,tsx}` + `scripts/**\/*.test.ts`). */
export const RE_UNIVERSO_VITEST = /^(src\/.+\.(test|spec)\.tsx?|scripts\/.+\.test\.ts)$/;
export const RE_CITA_DOCS = /\bdocs\b|CLAUDE\.md|README\.md/;

export type Decisao = { soDocs: boolean; motivo: string };

export function decidir(evento: string, pais: number | null, diff: { status: number | null; caminhos: string[] }): Decisao {
  if (evento !== 'pull_request') return { soDocs: false, motivo: `evento ${evento || '<vazio>'} roda tudo` };
  if (pais !== 2) return { soDocs: false, motivo: `HEAD com ${pais ?? '?'} pai(s), esperava o merge sintético do PR` };
  if (diff.status !== 0) return { soDocs: false, motivo: `git diff saiu ${diff.status ?? 'sem status'}` };
  if (diff.caminhos.length === 0) return { soDocs: false, motivo: 'diff vazio' };
  const fora = diff.caminhos.filter((c) => !RE_DOC.test(c));
  if (fora.length > 0) {
    return { soDocs: false, motivo: `${fora.length} arquivo(s) fora de docs/**/*.md: ${fora.slice(0, 5).join(', ')}` };
  }
  return { soDocs: true, motivo: `os ${diff.caminhos.length} arquivo(s) do PR são docs/**/*.md` };
}

/** `git diff -z` → caminhos. O último campo vazio (NUL final) sai; um campo vazio no meio é lixo. */
export function caminhosNul(saida: string): string[] {
  return saida.split('\0').filter((c) => c.length > 0);
}

export type Selecao = { arquivos: string[]; erro: string | null };

export function selecionarTestes(rastreados: string[], ler: (f: string) => string): Selecao {
  const universo = rastreados.filter((f) => RE_UNIVERSO_VITEST.test(f));
  const faltam = LEITORES_DE_DOCS.filter((f) => !universo.includes(f));
  if (faltam.length > 0) return { arquivos: [], erro: `leitor(es) de docs fora do universo do vitest: ${faltam.join(', ')}` };
  const citam = universo.filter((f) => RE_CITA_DOCS.test(ler(f)));
  const arquivos = [...new Set([...LEITORES_DE_DOCS, ...citam])].sort();
  return { arquivos, erro: null };
}

function git(...args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
}

function modoEscopo(evento: string): number {
  let d: Decisao;
  try {
    let pais: number | null = null;
    let diff = { status: null as number | null, caminhos: [] as string[] };
    if (evento === 'pull_request') {
      const p = git('rev-list', '--parents', '-n', '1', 'HEAD');
      pais = p.status === 0 ? p.stdout.trim().split(/\s+/).length - 1 : null;
      if (pais === 2) {
        const r = git('diff', '--name-only', '-z', '--no-renames', 'HEAD^1', 'HEAD');
        diff = { status: r.status, caminhos: caminhosNul(r.stdout) };
      }
    }
    d = decidir(evento, pais, diff);
  } catch (e) {
    d = { soDocs: false, motivo: `erro: ${mensagemDeErro(e) ?? 'desconhecido'}` };
  }
  console.log(`DOCS_ESCOPO so_docs=${d.soDocs} — ${d.motivo}`);
  const saida = process.env.GITHUB_OUTPUT;
  if (!saida) {
    console.error('::error::GITHUB_OUTPUT ausente — sem saída, os jobs pesados rodam.');
    return 1;
  }
  appendFileSync(saida, `so_docs=${d.soDocs}\n`);
  return 0;
}

/**
 * Peso relativo (segundos, M2 local em 2026-11-16) dos arquivos LENTOS da seleção; o resto pesa
 * `PESO_PADRAO`. Bytes não servem de proxy: os lentos varrem o repo ou esperam relógio, não são
 * grandes (o `sonda-versao-sql`, de 165 KB, leva 12 s; o `mapa-coerente-na-ref`, de 15 KB, 27 s).
 * Tabela velha só DESBALANCEIA as partes — nunca tira arquivo da seleção, que é a mesma com ou sem ela.
 */
export const PESO_SEGUNDOS: Readonly<Record<string, number>> = {
  'scripts/authz-funcoes.test.ts': 31,
  'scripts/provas-sql-escopo.test.ts': 27,
  'scripts/lib/mapa-coerente-na-ref.test.ts': 27,
  'scripts/assert-verde-por-ausencia-gate.test.ts': 25,
  'scripts/universo-pedidos-sql-gate.test.ts': 22,
  'scripts/exclusividade-medir-teto-1.test.ts': 20,
  'scripts/exclusividade-medir-fora-da-rodada.test.ts': 19,
  'scripts/fuso-da-sessao-em-migrations-e-skills-gate.test.ts': 19,
  'scripts/exclusividade-medir.test.ts': 18,
  'scripts/exclusividade-medir-teto-2.test.ts': 13,
  'scripts/sonda-versao-sql.test.ts': 12,
  'scripts/relogio-nu-da-sessao-gate.test.ts': 12,
  'scripts/authz-gate-check.test.ts': 11,
  'src/__tests__/paginacao-artesanal-gate.test.ts': 10,
  'scripts/falsificar-exige-assert-gate.test.ts': 7,
  'scripts/fuso-da-sessao-gate.test.ts': 7,
};
export const PESO_PADRAO = 1;
export const pesoDe = (f: string): number => PESO_SEGUNDOS[f] ?? PESO_PADRAO;

/**
 * Partição LPT (maior primeiro, para a parte de menor peso; empate → menor índice, e o nome desempata a
 * ordem): determinística, disjunta, e a união é a entrada.
 */
export function particionar(arquivos: readonly string[], peso: (f: string) => number, n: number): string[][] {
  const partes = Array.from({ length: n }, () => ({ peso: 0, arquivos: [] as string[] }));
  const ordem = [...arquivos].sort((a, b) => peso(b) - peso(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const f of ordem) {
    let alvo = partes[0];
    for (const p of partes) if (p.peso < alvo.peso) alvo = p;
    alvo.peso += peso(f);
    alvo.arquivos.push(f);
  }
  return partes.map((p) => p.arquivos.sort());
}

/** `i/N` com 1 ≤ i ≤ N, inteiros sem sinal nem zero à esquerda; qualquer outra forma é `null`. */
export function lerParte(texto: string): { i: number; n: number } | null {
  const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(texto);
  if (!m) return null;
  const i = Number(m[1]);
  const n = Number(m[2]);
  return i <= n ? { i, n } : null;
}

function modoTestes(parteTexto: string | null): number {
  const r = git('ls-files', '-z');
  if (r.status !== 0) {
    console.error(`::error::git ls-files saiu ${r.status ?? 'sem status'} — sem universo, sem seleção.`);
    return 1;
  }
  const sel = selecionarTestes(caminhosNul(r.stdout), (f) => readFileSync(f, 'utf8'));
  if (sel.erro || sel.arquivos.length === 0) {
    console.error(`::error::${sel.erro ?? 'seleção vazia'}`);
    return 1;
  }
  console.log(`DOCS_TESTES ${sel.arquivos.length} arquivo(s) vitest que citam ou leem docs (${LEITORES_DE_DOCS.length} obrigatórios)`);
  let arquivos = sel.arquivos;
  if (parteTexto !== null) {
    const parte = lerParte(parteTexto);
    if (!parte) {
      console.error(`::error::--parte '${parteTexto}' inválida — o formato é i/N com 1 ≤ i ≤ N.`);
      return 1;
    }
    arquivos = particionar(sel.arquivos, pesoDe, parte.n)[parte.i - 1];
    if (arquivos.length === 0) {
      console.error(`::error::a parte ${parte.i}/${parte.n} saiu vazia — mais partes que arquivos.`);
      return 1;
    }
    console.log(`DOCS_TESTES_PARTE ${parte.i}/${parte.n}: ${arquivos.length} de ${sel.arquivos.length} arquivo(s)`);
  }
  const v = spawnSync('bunx', ['vitest', 'run', ...arquivos], { stdio: 'inherit' });
  if (v.error) console.error(`::error::vitest não executou: ${v.error.message}`);
  return v.status ?? 1;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--evento');
  const p = argv.indexOf('--parte');
  if (argv.includes('--testes')) process.exit(modoTestes(p >= 0 ? (argv[p + 1] ?? '') : null));
  else if (i >= 0) process.exit(modoEscopo(argv[i + 1] ?? ''));
  else {
    console.error('uso: bun ./scripts/docs-escopo.ts --evento <nome> | --testes [--parte i/N]');
    process.exit(2);
  }
}
