#!/usr/bin/env bun
/**
 * provas-sql-escopo.ts — ESTE diff alcança alguma coisa que as provas SQL leem?
 * ============================================================================================
 *
 * O job `provas-sql` (ci.yml) roda o núcleo `db/nucleo-ci.txt` em 7 partes de ~14 min cada:
 * ≈100 runner-min por run, 73% de todo o runner de um PR (medido no #3583, só `docs/`: 102,9 de
 * 141 min) e o caminho crítico da parede. Nos 100 PRs mergeados até 2026-11-04, 49 tocaram só
 * arquivos que nenhuma prova lê. Este script decide, em segundos e sem `bun install`, se o
 * `provas-sql` (e a união dele) roda ou fica SKIPPED. Mesmo padrão do `mutcheck-escopo.ts`.
 *
 * O desenho é uma ALLOWLIST DO INERTE, não uma lista do que as provas leem: o PR só pula quando
 * TODO arquivo mudado cai num prefixo que nenhuma prova lê por inteiro (`INERTES`) e fora do que
 * as provas leem lá dentro (`lidosEmInerte`, CALCULADO a cada run sobre a árvore do PR). Qualquer
 * outro caminho — `db/`, `supabase/`, `scripts/`, `.github/`, `package.json`, `bun.lock`,
 * `tsconfig.json`, um diretório que ainda não existe — RODA. Prova nova que leia `scripts/x` não
 * tem como escapar; a que passe a ler `src/x` entra no cálculo sozinha, se citar o caminho em
 * `db/` ou chegar a ele por import. O verde-falso que sobra é leitura que não deixa rastro textual
 * (caminho montado em variável, `find src/`) — e esse escapa só no PR: na main (push do Lovable,
 * cron, dispatch manual e o dispatch que o auto-merge faz a cada merge) roda TUDO, e a main vermelha
 * abre `ci-main-red`. A ÚNICA exceção da main é o dispatch pós-merge com diff CUMULATIVO só de
 * `docs/` desde uma base de provas verdes (E14 do plano v7, bloco "Escopo da MAIN" abaixo): ela não
 * usa a allowlist do PR, e um código não provado fica no diff cumulativo e faz rodar.
 *
 * O mapa de leitura medido (2026-11-04, sobre as 171 provas do manifesto, os 2 runners e o que
 * eles carregam transitivamente) e a medição de runner-min: docs/historico/ci-provas-sql-escopo.md.
 *
 * Fail-CLOSED em toda incerteza: evento ≠ `pull_request` (fora o dispatch pós-merge acima), merge
 * commit sem 2 pais, diff ilegível ou VAZIO, base desconhecida ou não ancestral ⇒ roda. O script NUNCA sai ≠ 0 — erro vira `roda=true` — e o `provas-sql` só pula com
 * `roda` EXPLICITAMENTE 'false'; o `validate` só aceita o SKIPPED com o `success` deste job e o
 * `roda=false` dele lidos juntos.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { arquivosMudados, paisDoMerge } from './mutcheck-escopo';
import { mensagemDeErro } from '@/lib/erro-mensagem';

/** Prefixos que nenhuma prova do núcleo lê por inteiro (o mapa está no doc do cabeçalho). */
export const INERTES: readonly string[] = ['docs/', 'src/', 'public/', '.claude/'];

export interface Decisao {
  roda: boolean;
  motivos: string[];
}

function normaliza(p: string): string {
  return p.replace(/^\.\//, '');
}

/**
 * Caminho sob prefixo inerte citado LITERALMENTE num texto — `src/lib/x.ts`, `../../src/lib/x`,
 * `$REPO_ROOT/.claude/skills/y/z.sql`. Comentário conta de propósito (o custo é só precisão: um doc
 * citado em comentário passa a disparar as provas). O prefixo NU (`src/` sozinho) não entra: ele
 * aparece em prosa ("nenhuma chamada em src/") e tiraria `src/` inteiro do inerte.
 *
 * `docs/` fica FORA da citação, e é a única concessão do cálculo: `db/` cita ~100 docs em
 * comentário (`docs/agent/database.md` 109 vezes), nenhuma prova lê nenhum (mapa de 2026-11-04), e
 * contá-los devolveria ao núcleo justamente o PR só de docs, o maior bloco dos que pulam. Prova que
 * passe a LER um doc tem de, no mesmo PR, pôr `docs` de volta neste regex E tirar o pulo da main
 * (`DOCUMENTAL`, escopo da MAIN abaixo), que assume o mesmo fato: nenhuma prova lê `docs/`.
 */
// A âncora à esquerda aceita a RAIZ montada em variável — `$REPO_ROOT/`, `${RAIZ}/`, `$(git
// rev-parse --show-toplevel)/` —, que é como as provas citam caminho; só `outro/dir/src/x` não casa.
const ANCORA = String.raw`(?:^|[^\w.@/-]|\$\{?\w+\}?/|\)/)`;
const CITACAO = new RegExp(String.raw`${ANCORA}(?:\.\.\/)*((?:src|public|\.claude)\/[\w.@/-]*[\w@/-])`, 'g');
const CITACAO_SCRIPT = new RegExp(String.raw`${ANCORA}(?:\.\.\/)*(scripts\/[\w.@/-]+\.(?:ts|mts|js|mjs))\b`, 'g');
const IMPORTA =
  /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

export function citacoes(texto: string, re: RegExp = CITACAO): string[] {
  const out: string[] = [];
  for (const m of texto.matchAll(re)) {
    const c = m[1].replace(/\.+$/, '');
    if (!INERTES.includes(c) && !INERTES.includes(`${c}/`)) out.push(c);
  }
  return out;
}

export interface Resolvido {
  /** O especificador sem extensão — o que conta como LIDO: casa `.ts`, `.tsx`, `.mts`, `.js`… */
  base: string;
  /** TODOS os candidatos que existem, para o fecho seguir por cada um. */
  existentes: string[];
}

/**
 * Resolve um especificador de import (`@/x`, `./x`, `../x`); pacote/builtin ⇒ null. NÃO escolhe
 * um candidato, de propósito (parecer Codex 2026-11-04): o Bun prefere `.tsx` a `.ts`, e um PR que
 * acrescente `x.tsx` ao lado de `x.ts` muda o que a prova carrega. Por isso o lido é a `base` sem
 * extensão, que casa qualquer uma (e `base/…`, se for diretório), e o fecho segue todas.
 */
export function resolverImport(de: string, esp: string, existe: (p: string) => boolean): Resolvido | null {
  let alvo: string;
  if (esp.startsWith('@/')) alvo = `src/${esp.slice(2)}`;
  else if (esp.startsWith('.')) alvo = posix.normalize(posix.join(posix.dirname(de), esp));
  else return null; // pacote de node_modules / builtin `node:*`
  const base = alvo.replace(/\.(tsx?|mts|m?js|json)$/, '');
  const exts = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '.json'];
  const candidatos = [alvo, ...exts.map((e) => `${base}${e}`), ...exts.slice(1).map((e) => `${base}/index${e}`)];
  return { base, existentes: [...new Set(candidatos)].filter(existe) };
}

export interface Repo {
  arquivos: readonly string[];
  ler: (p: string) => string | null;
  existe: (p: string) => boolean;
}

/**
 * O que as provas LEEM dentro dos prefixos inertes, CALCULADO a cada run sobre a árvore do PR — e
 * não uma lista à mão, que apodrece calada quando uma prova nova passa a ler `src/x`:
 *  1. todo caminho sob prefixo inerte citado em qualquer arquivo de `db/` (`citacoes`);
 *  2. o fecho de imports TS (`@/`, relativos, `import()`, `require`) a partir de todo `.ts` de
 *     `db/` e de todo `scripts/*.ts` citado em `db/` — é como as provas chegam a `src/lib/…`
 *     (`bun scripts/venda-recompra-esperado.ts` → `../src/lib/farmer/universo-pedidos`).
 * Sobra-aproximação de propósito: `db/` inteiro, não só o manifesto; comentário conta.
 */
export function lidosEmInerte(repo: Repo): Set<string> {
  const lidos = new Set<string>();
  const fila: string[] = [];
  for (const f of repo.arquivos) {
    if (!f.startsWith('db/')) continue;
    const t = repo.ler(f);
    if (t === null) continue;
    for (const c of citacoes(t)) lidos.add(c);
    for (const s of citacoes(t, CITACAO_SCRIPT)) fila.push(s);
    if (/\.(ts|mts|js|mjs)$/.test(f)) fila.push(f);
  }
  const visto = new Set<string>();
  while (fila.length > 0) {
    const f = fila.pop()!;
    if (visto.has(f)) continue;
    visto.add(f);
    if (INERTES.some((p) => f.startsWith(p))) lidos.add(f);
    const t = repo.ler(f);
    if (t === null) continue;
    for (const m of t.matchAll(IMPORTA)) {
      const esp = m.slice(1).find(Boolean)!;
      const r = resolverImport(f, esp, repo.existe);
      if (!r) continue;
      if (INERTES.some((p) => r.base.startsWith(p))) lidos.add(r.base);
      fila.push(...r.existentes);
    }
  }
  return lidos;
}

/**
 * O arquivo é inerte para as provas? Raiz do repo nunca é (não há prefixo que a cubra). Um lido
 * casa o arquivo igual, ou como diretório (`src/lib/gates` cobre `src/lib/gates/x.ts`).
 */
export function inerte(arquivo: string, lidos: ReadonlySet<string>): boolean {
  const f = normaliza(arquivo);
  // Sem extensão também casa: o import de um arquivo que o PR APAGA não resolve na árvore do PR e
  // fica como `src/lib/x` — o diff traz `src/lib/x.ts`, e esse PR tem de rodar.
  const semExt = f.replace(/\.(tsx?|mts|m?js|json)$/, '');
  for (const l of lidos) {
    const d = l.endsWith('/') ? l : `${l}/`;
    if (f === l || semExt === l || f.startsWith(d)) return false;
  }
  return INERTES.some((p) => f.startsWith(p));
}

export function decidir(
  evento: string,
  mudados: readonly string[] | null,
  lidos: ReadonlySet<string> | null,
): Decisao {
  if (evento !== 'pull_request') {
    return { roda: true, motivos: [`evento '${evento}' — fora de PR roda TUDO (é a rede da main)`] };
  }
  if (mudados === null) return { roda: true, motivos: ['diff ilegível — sem escopo, roda TUDO (fail-closed)'] };
  if (mudados.length === 0) {
    return { roda: true, motivos: ['diff VAZIO — ausência de dado, não "nada mudou": roda TUDO (fail-closed)'] };
  }
  if (lidos === null) {
    return { roda: true, motivos: ['mapa do que as provas leem ilegível — roda TUDO (fail-closed)'] };
  }
  const alcancam = mudados.filter((f) => !inerte(f, lidos));
  if (alcancam.length > 0) {
    const amostra = alcancam.slice(0, 5).join(', ');
    const resto = alcancam.length > 5 ? ` (+${alcancam.length - 5})` : '';
    return { roda: true, motivos: [`${alcancam.length} arquivo(s) que as provas podem ler: ${amostra}${resto}`] };
  }
  return {
    roda: false,
    motivos: [`os ${mudados.length} arquivo(s) do diff caem em ${INERTES.join(' ')} e fora do que as provas leem`],
  };
}

// ─── Escopo da MAIN (E14 do plano v7, 2026-11-06) ───────────────────────────────────────────────
// O auto-merge dispara um CI na main a cada merge, e esse dispatch rodava as 7 partes mesmo depois de
// merge só de docs (8 de 13 merges num dia; ~106 runner-min e a pior fila do CI por run). A reabertura
// é ESTREITA de propósito: a allowlist do PR (`INERTES`, com `src/`, `public/`, `.claude/`) NÃO vale
// aqui, porque a main é a rede que pega o que escapa do cálculo do PR. Aqui só pula o diff CUMULATIVO
// exclusivamente sob `docs/`, contado desde uma BASE cujas provas e cuja união terminaram `success` —
// não "workflow verde", que pode ter as provas puladas — e contra o SHA FIXO do run. Um merge de código
// que ainda não foi provado (run vermelho, cancelado ou coalescido) fica dentro do diff cumulativo e
// faz o próximo run rodar tudo: o atraso máximo de uma prova é até o próximo merge que não seja docs,
// ou o cron diário, que segue rodando tudo.

/** O único prefixo que a main aceita pular. Não estenda aos `INERTES` do PR (ver o bloco acima). */
export const DOCUMENTAL = 'docs/';
/** Quantos runs da main olhar atrás da base, no máximo (um dia cheio tem ~30 merges). */
export const MAX_CANDIDATOS = 40;
const SHA_RE = /^[0-9a-f]{40}$/;
const PARTE_RE = /^provas-sql \(\d+\)$/;

export interface JobDoRun {
  name: string;
  conclusion: string | null;
}

/**
 * As provas DESTE run terminaram verdes? Exige a união `success` (ela confere que a matriz agregou
 * `success` e que cada unidade do núcleo foi concluída exatamente uma vez) e, junto, ≥1 parte
 * `provas-sql (k)` com TODAS em `success`. Parte ou união `skipped` (run que o escopo pulou) não é base.
 */
export function provasVerdes(jobs: readonly JobDoRun[]): boolean {
  const uniao = jobs.filter((j) => j.name === 'provas-sql-uniao');
  const partes = jobs.filter((j) => PARTE_RE.test(j.name));
  return (
    uniao.length === 1 &&
    uniao[0].conclusion === 'success' &&
    partes.length > 0 &&
    partes.every((j) => j.conclusion === 'success')
  );
}

export interface RunDaMain {
  id: number;
  event: string;
  head_sha: string;
  head_branch: string;
  repo: string;
}

export interface Base {
  sha: string | null;
  motivo: string;
}

/**
 * O run EXECUTOU as provas? Sim se alguma parte ou a união tem conclusão que não seja `skipped`
 * (inclusive `null`, que num run concluído é anomalia e conta como executada-não-verde). Run sem
 * esses jobs (pendente coalescido, cancelado antes de começar) ou com tudo `skipped` não executou.
 */
export function provasExecutadas(jobs: readonly JobDoRun[]): boolean {
  return jobs.some((j) => (j.name === 'provas-sql-uniao' || PARTE_RE.test(j.name)) && j.conclusion !== 'skipped');
}

/**
 * A base é o run MAIS RECENTE da main (na ordem da API, por criação) que EXECUTOU as provas, e ele
 * tem de ter terminado com provas e união verdes. Só conta run da própria main (`push`/`schedule`/
 * `workflow_dispatch`, branch `main`, este repo), nunca o run atual. Runs que não executaram as provas
 * (pulados pelo escopo, coalescidos) são atravessados; o 1º que executou DECIDE:
 *  - verde ⇒ é a base;
 *  - não verde ⇒ SEM base. Sem isso, um vermelho sem mudança de código (relógio, ambiente, prova
 *    intermitente) seria apagado pelo dispatch só de docs seguinte, que acharia uma base verde mais
 *    antiga da mesma árvore e fecharia o `ci-main-red` (ressalva do Codex, 2026-11-06).
 * Jobs ilegíveis num candidato também PARAM a busca (fail-closed). Se a base não for ancestral, roda.
 */
export function escolherBase(
  runs: readonly RunDaMain[],
  runAtual: number,
  repo: string,
  jobsDe: (id: number) => readonly JobDoRun[] | null,
): Base {
  let vistos = 0;
  for (const r of runs) {
    if (r.id === runAtual) continue;
    if (!['push', 'schedule', 'workflow_dispatch'].includes(r.event)) continue;
    if (r.head_branch !== 'main' || r.repo !== repo || !SHA_RE.test(r.head_sha)) continue;
    if (++vistos > MAX_CANDIDATOS) break;
    const jobs = jobsDe(r.id);
    if (jobs === null) return { sha: null, motivo: `jobs do run ${r.id} ilegíveis — sem base (fail-closed)` };
    if (!provasExecutadas(jobs)) continue;
    if (provasVerdes(jobs)) return { sha: r.head_sha, motivo: `run ${r.id} (${r.event}) com provas e união verdes` };
    return {
      sha: null,
      motivo: `o run mais recente que executou as provas (${r.id}, ${r.event}) não terminou com provas e união verdes`,
    };
  }
  return { sha: null, motivo: `nenhum dos ${Math.min(vistos, MAX_CANDIDATOS)} run(s) da main olhados executou as provas` };
}

export interface FatosMain {
  /** O SHA fixo do run (`github.sha`), não o HEAD de agora da main. */
  sha: string;
  base: Base;
  /** `git merge-base --is-ancestor base sha`: true, false, ou null quando inconclusivo. */
  ancestral: boolean | null;
  /** `git diff base sha`; null = ilegível. */
  mudados: readonly string[] | null;
}

export interface DecisaoMain extends Decisao {
  /** Só quando pula: a base verde que justifica o pulo (vai para a saída `base`, que o validate exige). */
  base?: string;
}

export function decidirMain(f: FatosMain): DecisaoMain {
  if (!SHA_RE.test(f.sha)) return { roda: true, motivos: [`SHA do run '${f.sha}' inválido — roda TUDO`] };
  const b = f.base.sha;
  if (b === null || !SHA_RE.test(b)) {
    return { roda: true, motivos: [`base desconhecida (${f.base.motivo}) — roda TUDO`] };
  }
  if (b === f.sha) {
    return { roda: true, motivos: [`a base é o próprio SHA ${b.slice(0, 9)} — diff vazio é ausência de dado: roda TUDO`] };
  }
  if (f.ancestral !== true) {
    const como = f.ancestral === false ? 'não é ancestral' : 'ancestralidade inconclusiva';
    return { roda: true, motivos: [`a base ${b.slice(0, 9)} ${como} de ${f.sha.slice(0, 9)} — roda TUDO`] };
  }
  if (f.mudados === null) return { roda: true, motivos: ['diff cumulativo ilegível — roda TUDO (fail-closed)'] };
  if (f.mudados.length === 0) {
    return { roda: true, motivos: ['diff cumulativo VAZIO — ausência de dado: roda TUDO (fail-closed)'] };
  }
  const fora = f.mudados.map(normaliza).filter((m) => !m.startsWith(DOCUMENTAL));
  if (fora.length > 0) {
    const amostra = fora.slice(0, 5).join(', ');
    const resto = fora.length > 5 ? ` (+${fora.length - 5})` : '';
    return {
      roda: true,
      motivos: [`desde a base verde ${b.slice(0, 9)} (${f.base.motivo}), ${fora.length} arquivo(s) fora de docs/: ${amostra}${resto}`],
    };
  }
  return {
    roda: false,
    base: b,
    motivos: [`desde a base verde ${b.slice(0, 9)} (${f.base.motivo}), os ${f.mudados.length} arquivo(s) do diff cumulativo são todos de docs/`],
  };
}

/** `gh api` com UMA re-tentativa (um 502 da API custaria ~106 runner-min de provas que não precisavam rodar). */
function ghJson(rota: string): unknown {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return JSON.parse(
        execFileSync('gh', ['api', rota], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }),
      );
    } catch (e) {
      if (tentativa >= 2) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
    }
  }
}

/** Corpo da lista de runs → `RunDaMain[]`; forma inesperada ⇒ null (sem base, roda). */
export function runsDoCorpo(corpo: unknown): RunDaMain[] | null {
  const lista = (corpo as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(lista)) return null;
  return lista.map((r: Record<string, unknown>) => ({
    id: Number(r?.id),
    event: String(r?.event),
    head_sha: String(r?.head_sha),
    head_branch: String(r?.head_branch),
    repo: String((r?.head_repository as { full_name?: unknown } | null)?.full_name ?? ''),
  }));
}

/**
 * Corpo da lista de jobs → `JobDoRun[]`; forma inesperada ou página INCOMPLETA (`total_count` maior
 * que os jobs recebidos, ou ausente) ⇒ null: não dá para afirmar que TODAS as partes passaram.
 */
export function jobsDoCorpo(corpo: unknown): JobDoRun[] | null {
  const c = corpo as { jobs?: unknown; total_count?: unknown } | null;
  if (!c || !Array.isArray(c.jobs)) return null;
  if (typeof c.total_count !== 'number' || c.total_count > c.jobs.length) return null;
  return c.jobs.map((j: Record<string, unknown>) => ({
    name: String(j?.name),
    conclusion: typeof j?.conclusion === 'string' ? j.conclusion : null,
  }));
}

/** Os runs concluídos do ci.yml na main, como a API os ordena (mais recente primeiro). */
export function lerRunsDaMain(repo: string): RunDaMain[] {
  const runs = runsDoCorpo(
    ghJson(`repos/${repo}/actions/workflows/ci.yml/runs?branch=main&status=completed&exclude_pull_requests=true&per_page=100`),
  );
  if (runs === null) throw new Error('lista de runs sem workflow_runs');
  return runs;
}

export function lerJobs(repo: string, id: number): JobDoRun[] | null {
  try {
    return jobsDoCorpo(ghJson(`repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`));
  } catch {
    return null;
  }
}

/** true/false pelo exit do git (0/1); qualquer outro (objeto ausente, histórico raso) ⇒ null. */
export function ehAncestral(base: string, sha: string, cwd?: string): boolean | null {
  const r = spawnSync('git', ['merge-base', '--is-ancestor', base, sha], { encoding: 'utf8', cwd });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

/** A árvore versionada do checkout (`git ls-files`). Falha ⇒ null, e o escopo roda TUDO. */
export function lerRepo(): Repo | null {
  try {
    const arquivos = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);
    if (arquivos.length === 0) return null;
    const conjunto = new Set(arquivos);
    return {
      arquivos,
      existe: (p) => conjunto.has(p),
      ler: (p) => {
        try {
          return readFileSync(p, 'utf8');
        } catch {
          return null;
        }
      },
    };
  } catch {
    return null;
  }
}

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const querSaida = process.argv.includes('--github-output');
  let roda = true;
  let base: string | undefined;
  try {
    const evento = arg('--evento') ?? 'pull_request';
    // Modo da MAIN: só o dispatch pós-merge (input `provas_escopo_docs`, que o auto-merge passa) na
    // ref main. Push do Lovable, cron diário e dispatch manual seguem rodando TUDO pelo `decidir`.
    const modoMain =
      evento === 'workflow_dispatch' && arg('--escopo-docs') === 'true' && arg('--ref') === 'refs/heads/main';
    if (modoMain) {
      const sha = arg('--sha') ?? '';
      const repo = arg('--repo') ?? '';
      const runAtual = Number(arg('--run-id'));
      let b: Base;
      try {
        b = escolherBase(lerRunsDaMain(repo), runAtual, repo, (id) => lerJobs(repo, id));
      } catch (e) {
        b = { sha: null, motivo: `lista de runs ilegível: ${mensagemDeErro(e) ?? 'erro desconhecido'}` };
      }
      const ok = b.sha !== null && SHA_RE.test(b.sha) && SHA_RE.test(sha);
      const d = decidirMain({
        sha,
        base: b,
        ancestral: ok ? ehAncestral(b.sha!, sha) : null,
        mudados: ok ? arquivosMudados(b.sha!, sha) : null,
      });
      roda = d.roda;
      base = d.roda ? undefined : d.base;
      for (const m of d.motivos) console.log(`  · ${m}`);
    } else {
      let mudados: string[] | null = null;
      if (evento === 'pull_request') {
        const b = arg('--base');
        const par = b ? { base: b, head: arg('--head') ?? 'HEAD' } : paisDoMerge();
        mudados = par ? arquivosMudados(par.base, par.head) : null;
      }
      const repo = evento === 'pull_request' ? lerRepo() : null;
      const lidos = repo === null ? null : lidosEmInerte(repo);
      if (lidos !== null) {
        console.log(`provas-sql-escopo: ${lidos.size} caminho(s) lidos pelas provas dentro de ${INERTES.join(' ')}`);
        if (process.argv.includes('--lidos')) for (const l of [...lidos].sort()) console.log(`    ${l}`);
      }
      const d = decidir(evento, mudados, lidos);
      roda = d.roda;
      for (const m of d.motivos) console.log(`  · ${m}`);
    }
    console.log(
      roda
        ? 'provas-sql-escopo: RODA o núcleo inteiro.'
        : 'provas-sql-escopo: nada que as provas leem — provas-sql e a união ficam puladas.',
    );
  } catch (e) {
    roda = true;
    base = undefined;
    console.log(`::warning::provas-sql-escopo não decidiu (${mensagemDeErro(e) ?? 'erro desconhecido'}) — roda TUDO.`);
  }
  if (querSaida) {
    try {
      if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT ausente');
      appendFileSync(process.env.GITHUB_OUTPUT, `roda=${roda}\n${base ? `base=${base}\n` : ''}`);
    } catch (e) {
      // Saída ausente: a condição do `provas-sql` (`roda != 'false'`) roda mesmo assim.
      console.log(`::warning::sem saída do escopo (${mensagemDeErro(e) ?? 'erro desconhecido'}) — o provas-sql roda.`);
    }
  }
  process.exit(0);
}
