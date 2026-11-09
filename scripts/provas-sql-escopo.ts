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
import { appendFileSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
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
  /** Se `p` é symlink, o caminho (do repo) para onde ele aponta; senão null. */
  alvo?: (p: string) => string | null;
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
export function lidosEmInerte(repo: Repo): Set<string> | null {
  const lidos = new Set<string>();
  const fila: string[] = [];
  const segueLink = (f: string) => {
    const a = repo.alvo?.(f) ?? null;
    if (a === null) return;
    if (INERTES.some((p) => a.startsWith(p))) lidos.add(a);
    fila.push(a);
  };
  for (const f of repo.arquivos) {
    if (!f.startsWith('db/')) continue;
    segueLink(f);
    const t = repo.ler(f);
    // Arquivo versionado de `db/` que não se lê é mapa INCOMPLETO, não "não lê nada" (parecer Codex
    // 2026-11-09): o escopo inteiro cai em `lidos === null` e roda TUDO.
    if (t === null) return null;
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
    segueLink(f);
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
  // `.gitattributes` muda os BYTES do checkout (eol, filtros) de arquivos que as provas leem, de
  // qualquer diretório (parecer Codex 2026-11-09: `src/.gitattributes` com `eol=crlf` reprovaria um
  // `grep` ancorado de prova): nunca é inerte.
  if (posix.basename(f) === '.gitattributes') return false;
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

// ─── Recibo do MESMO PR (fatia C do programa "merge mais rápido", 2026-11-09) ────────────────────
// Medido em 06–09/11 (236 runs de PR): 17 cancelamentos foram de push só de docs num PR cujas provas
// JÁ tinham passado. O PR inteiro toca SQL, então o `decidir` acima roda tudo de novo, embora o push
// novo não mude nada que as provas leem. Aqui o PR reaproveita o resultado de um run ANTERIOR do
// mesmo PR, e só com estas provas, cada uma por fonte verificável (API do GitHub + git do checkout):
//  - o run-recibo é do MESMO PR (branch + repo, e a anotação dele diz o número do PR) e o mais
//    recente que EXECUTOU as provas terminou com todas as partes e a união `success` (vermelho ou
//    cancelado mais novo ⇒ sem recibo: não se atravessa um vermelho até achar um verde velho);
//  - a anotação do escopo DAQUELE run (API de check-runs) diz qual merge commit ele testou: a base B1
//    (main da época) e o head H1, que tem de ser o `head_sha` do run;
//  - H1 é ancestral do head atual H2, sem merge commit no meio (merge da main ⇒ roda) e com o MESMO
//    merge-base contra a main (rebase ⇒ roda); B1 é ancestral da base atual B2;
//  - a ÁRVORE que o recibo testou é RECALCULADA aqui (`git merge-tree --write-tree B1 H1`) e tem de
//    bater com a que a anotação registrou; aí o diff entre ela e a árvore de agora é EXATO (parecer
//    Codex 2026-11-09: o argumento "merge de 3 vias por arquivo" falha com renomeação e base virtual);
//  - TODO arquivo desse diff — que não pode ser vazio — e de diff(H1,H2) é inerte pelo MESMO critério
//    do `decidir` (`inerte`, com os lidos da árvore de AGORA), e nenhum vira/era symlink ou submódulo.
// O drift da main é aceito só se inerte; sem isso o recibo quase nunca valeria (a main anda ~30×/dia).
// Na dúvida, roda: qualquer leitura falha ou fora de forma ⇒ sem recibo.

/** Título da anotação que todo run de PR deixa no job de escopo, com o merge commit que testou. */
export const TITULO_RECIBO = 'provas-sql-recibo';
/** Quantos runs do PR olhar para trás, no máximo. */
export const MAX_RUNS_PR = 10;

export function anotacaoRecibo(pr: number, m: MergeTestado): string {
  return `::notice title=${TITULO_RECIBO}::pr=${pr} base=${m.base} head=${m.head} tree=${m.tree}`;
}

export interface RunDoPr {
  id: number;
  event: string;
  status: string;
  head_sha: string;
  head_branch: string;
  repo: string;
}

/** Corpo da lista de runs do PR → `RunDoPr[]`; forma inesperada ⇒ null (sem recibo). */
export function runsDoPrCorpo(corpo: unknown): RunDoPr[] | null {
  const lista = (corpo as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(lista)) return null;
  return lista.map((r: Record<string, unknown>) => ({
    id: Number(r?.id),
    event: String(r?.event),
    status: String(r?.status),
    head_sha: String(r?.head_sha),
    head_branch: String(r?.head_branch),
    repo: String((r?.head_repository as { full_name?: unknown } | null)?.full_name ?? ''),
  }));
}

export interface JobComId extends JobDoRun {
  id: number;
  check_run_url?: string;
}

/** Como `jobsDoCorpo`, guardando o id do job (é o id do check-run, onde mora a anotação). */
export function jobsComIdDoCorpo(corpo: unknown): JobComId[] | null {
  const base = jobsDoCorpo(corpo);
  if (base === null) return null;
  const jobs = (corpo as { jobs: Record<string, unknown>[] }).jobs;
  return base.map((j, i) => ({
    ...j,
    id: Number(jobs[i]?.id),
    check_run_url: typeof jobs[i]?.check_run_url === 'string' ? (jobs[i].check_run_url as string) : undefined,
  }));
}

export interface MergeTestado {
  base: string;
  head: string;
  /** A árvore do merge commit testado. */
  tree: string;
}

/**
 * As anotações do job de escopo do run-recibo → o merge commit que ele testou. Exige EXATAMENTE uma
 * anotação com o título, do PR certo, com o head igual ao `head_sha` do run; qualquer outra forma ⇒ null.
 */
export function mergeDaAnotacao(corpo: unknown, pr: number, headDoRun: string): MergeTestado | null {
  if (!Array.isArray(corpo)) return null;
  const minhas = corpo.filter((a) => (a as { title?: unknown })?.title === TITULO_RECIBO);
  if (minhas.length !== 1) return null;
  const msg = String((minhas[0] as { message?: unknown }).message ?? '').trim();
  const m = /^pr=([1-9]\d*) base=([0-9a-f]{40}) head=([0-9a-f]{40}) tree=([0-9a-f]{40})$/.exec(msg);
  if (!m || Number(m[1]) !== pr || m[3] !== headDoRun) return null;
  return { base: m[2], head: m[3], tree: m[4] };
}

export interface Recibo {
  run: RunDoPr;
  jobs: readonly JobComId[];
}

/**
 * O run-recibo: o mais recente do PR (ordem da API, por criação) que EXECUTOU as provas, e só se ele
 * terminou com provas e união verdes. Mesmo critério do `escolherBase` da main: o 1º que executou
 * DECIDE. Run de outra branch, de outro repo (fork), de outro evento, não concluído ou o próprio run
 * atual é ignorado; jobs ilegíveis PARAM a busca (fail-closed).
 */
export function escolherRecibo(
  runs: readonly RunDoPr[],
  runAtual: number,
  repo: string,
  headRef: string,
  jobsDe: (id: number) => readonly JobComId[] | null,
): Recibo | { motivo: string } {
  let vistos = 0;
  for (const r of runs) {
    if (r.id === runAtual || !Number.isSafeInteger(r.id) || r.id <= 0) continue;
    if (r.event !== 'pull_request' || r.status !== 'completed') continue;
    if (r.head_branch !== headRef || r.repo !== repo || !SHA_RE.test(r.head_sha)) continue;
    if (++vistos > MAX_RUNS_PR) break;
    const jobs = jobsDe(r.id);
    if (jobs === null) return { motivo: `jobs do run ${r.id} ilegíveis — sem recibo (fail-closed)` };
    if (!provasExecutadas(jobs)) continue;
    if (provasVerdes(jobs)) return { run: r, jobs };
    return { motivo: `o run mais recente do PR que executou as provas (${r.id}) não terminou com provas e união verdes` };
  }
  return { motivo: `nenhum dos ${Math.min(vistos, MAX_RUNS_PR)} run(s) anteriores do PR executou as provas` };
}

export interface FatosRecibo {
  /** O merge commit testado AGORA: base B2 (main) e head H2 (PR). */
  atual: MergeTestado;
  /** O que a busca achou: o run e o merge que ele testou, ou o motivo de não haver. */
  recibo: { runId: number; merge: MergeTestado } | { motivo: string };
  /** H1 ancestral de H2 / B1 ancestral de B2 (`git merge-base --is-ancestor`); null = inconclusivo. */
  headAncestral: boolean | null;
  baseAncestral: boolean | null;
  /** `git rev-list --merges --count H1..H2`; null = ilegível. */
  merges: number | null;
  /** merge-base(B1,H1) e merge-base(B2,H2); null = ilegível. */
  forkRecibo: string | null;
  forkAtual: string | null;
  /** `git merge-tree --write-tree B1 H1` recalculado aqui; null = conflito/ilegível. */
  arvoreRecalculada: string | null;
  /** diff(H1,H2) e diff(árvore do recibo, árvore de agora); null = ilegível. */
  diffHead: readonly string[] | null;
  diffArvore: readonly EntradaDiff[] | null;
  lidos: ReadonlySet<string> | null;
}

export interface DecisaoRecibo extends Decisao {
  /** Só quando reaproveita: o id do run cujas provas valem para este. */
  recibo?: number;
}

function naoInertes(arquivos: readonly string[], lidos: ReadonlySet<string>): string {
  const fora = arquivos.filter((f) => !inerte(f, lidos));
  if (fora.length === 0) return '';
  return `${fora.slice(0, 5).join(', ')}${fora.length > 5 ? ` (+${fora.length - 5})` : ''}`;
}

export function decidirRecibo(f: FatosRecibo): DecisaoRecibo {
  const roda = (m: string): DecisaoRecibo => ({ roda: true, motivos: [`recibo: ${m} — roda TUDO`] });
  if ('motivo' in f.recibo) return roda(f.recibo.motivo);
  const { runId, merge: r } = f.recibo;
  const a = f.atual;
  if (![a.base, a.head, r.base, r.head].every((s) => SHA_RE.test(s))) return roda('SHA fora de forma');
  if (r.head === a.head) return roda(`o run ${runId} testou o MESMO head ${a.head.slice(0, 9)} (re-run não reaproveita)`);
  if (f.headAncestral !== true) return roda(`o head do run ${runId} não é ancestral do head atual (rebase/force-push?)`);
  if (f.baseAncestral !== true) return roda(`a base do run ${runId} não é ancestral da base atual`);
  if (f.merges !== 0) return roda(f.merges === null ? 'merges no intervalo ilegíveis' : `${f.merges} merge commit(s) desde o run ${runId} (merge da main?)`);
  if (f.forkRecibo === null || f.forkAtual === null || !SHA_RE.test(f.forkRecibo) || f.forkRecibo !== f.forkAtual) {
    return roda(`merge-base com a main mudou desde o run ${runId} (ou ilegível)`);
  }
  if (!SHA_RE.test(r.tree) || f.arvoreRecalculada !== r.tree) {
    return roda(`a árvore recalculada de B1+H1 (${f.arvoreRecalculada ?? 'conflito/ilegível'}) não é a que o run ${runId} registrou`);
  }
  if (f.lidos === null) return roda('mapa do que as provas leem ilegível');
  if (f.diffHead === null || f.diffArvore === null) return roda('diff desde o recibo ilegível');
  if (f.diffHead.length === 0 || f.diffArvore.length === 0) return roda('diff desde o recibo VAZIO (ausência de dado)');
  const h = naoInertes(f.diffHead, f.lidos);
  if (h) return roda(`desde o run ${runId}, o PR mudou arquivo(s) que as provas podem ler: ${h}`);
  const link = f.diffArvore.filter((e) => e.especial).map((e) => e.caminho);
  if (link.length > 0) return roda(`symlink/submódulo no diff desde o run ${runId}: ${link.slice(0, 5).join(', ')}`);
  const t = naoInertes(f.diffArvore.map((e) => e.caminho), f.lidos);
  if (t) return roda(`desde a árvore que o run ${runId} provou, mudou o que as provas podem ler: ${t}`);
  return {
    roda: false,
    recibo: runId,
    motivos: [
      `recibo: o run ${runId} provou a árvore ${r.tree.slice(0, 9)} (head ${r.head.slice(0, 9)} sobre a main ${r.base.slice(0, 9)}); dela até a de agora, ${f.diffArvore.length} arquivo(s), todos inertes — REAPROVEITA`,
    ],
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

function git(args: string[], cwd?: string): string | null {
  const r = spawnSync('git', args, { encoding: 'utf8', cwd, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** O merge commit do checkout (`HEAD`): {base: 1º pai, head: 2º pai}; sem exatamente 2 pais ⇒ null. */
export function mergeDoCheckout(cwd?: string): MergeTestado | null {
  const shas = (git(['rev-list', '--parents', '-n', '1', 'HEAD'], cwd) ?? '').split(/\s+/);
  const tree = git(['rev-parse', 'HEAD^{tree}'], cwd);
  if (shas.length !== 3 || !shas.every((s) => SHA_RE.test(s)) || tree === null || !SHA_RE.test(tree)) return null;
  return { base: shas[1], head: shas[2], tree };
}

/** A árvore que o merge de `base`+`head` produz (`merge-tree --write-tree`, merge-ort); conflito ⇒ null. */
export function arvoreDoMerge(base: string, head: string, cwd?: string): string | null {
  const s = git(['merge-tree', '--write-tree', base, head], cwd);
  return s !== null && SHA_RE.test(s) ? s : null;
}

export interface EntradaDiff {
  caminho: string;
  /** Symlink (120000) ou submódulo (160000) em algum dos lados: nunca inerte. */
  especial: boolean;
}

/** `git diff --raw` entre duas árvores, com o modo de cada lado; ilegível ⇒ null. */
export function diffComModo(a: string, b: string, cwd?: string): EntradaDiff[] | null {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--raw', '-z', '--no-renames', a, b], {
    encoding: 'utf8',
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  const partes = r.stdout.split('\0');
  const out: EntradaDiff[] = [];
  for (let i = 0; i + 1 < partes.length; i += 2) {
    const cab = /^:(\d{6}) (\d{6}) /.exec(partes[i]);
    if (!cab) return null;
    out.push({ caminho: partes[i + 1], especial: [cab[1], cab[2]].some((m) => m === '120000' || m === '160000') });
  }
  return out;
}

/** O check-run do job pela URL que a API devolve (sem presumir que o id do job é o do check-run). */
export function rotaDoCheckRun(job: JobComId): string {
  const m = /^https:\/\/api\.github\.com\/(repos\/[\w.-]+\/[\w.-]+\/check-runs\/\d+)$/.exec(job.check_run_url ?? '');
  if (!m) throw new Error(`check_run_url fora de forma no job ${job.id}`);
  return m[1];
}

export function mergeBase(a: string, b: string, cwd?: string): string | null {
  const s = git(['merge-base', a, b], cwd);
  return s !== null && SHA_RE.test(s) ? s : null;
}

export function contaMerges(de: string, ate: string, cwd?: string): number | null {
  const s = git(['rev-list', '--merges', '--count', `${de}..${ate}`], cwd);
  return s !== null && /^\d+$/.test(s) ? Number(s) : null;
}

/** Busca o recibo pela API e junta os fatos de git; qualquer erro vira `{ motivo }` (roda). */
export function fatosDoRecibo(
  repo: string,
  runAtual: number,
  headRef: string,
  pr: number,
  atual: MergeTestado,
  lidos: ReadonlySet<string> | null,
): FatosRecibo {
  const vazio = {
    headAncestral: null,
    baseAncestral: null,
    merges: null,
    forkRecibo: null,
    forkAtual: null,
    arvoreRecalculada: null,
    diffHead: null,
    diffArvore: null,
    lidos,
  };
  let recibo: FatosRecibo['recibo'];
  try {
    const runs = runsDoPrCorpo(
      ghJson(
        `repos/${repo}/actions/workflows/ci.yml/runs?event=pull_request&branch=${encodeURIComponent(headRef)}&per_page=${MAX_RUNS_PR + 5}`,
      ),
    );
    if (runs === null) throw new Error('lista de runs do PR sem workflow_runs');
    const achado = escolherRecibo(runs, runAtual, repo, headRef, (id) => {
      try {
        return jobsComIdDoCorpo(ghJson(`repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`));
      } catch {
        return null;
      }
    });
    if ('motivo' in achado) {
      recibo = achado;
    } else {
      const escopos = achado.jobs.filter((j) => j.name === 'provas-sql-escopo');
      if (escopos.length !== 1 || !Number.isSafeInteger(escopos[0].id) || escopos[0].id <= 0) {
        recibo = { motivo: `run ${achado.run.id} sem UM job provas-sql-escopo legível` };
      } else {
        const merge = mergeDaAnotacao(
          ghJson(`${rotaDoCheckRun(escopos[0])}/annotations?per_page=100`),
          pr,
          achado.run.head_sha,
        );
        recibo = merge
          ? { runId: achado.run.id, merge }
          : { motivo: `run ${achado.run.id} sem anotação '${TITULO_RECIBO}' válida deste PR (run anterior a esta regra?)` };
      }
    }
  } catch (e) {
    recibo = { motivo: `API ilegível: ${mensagemDeErro(e) ?? 'erro desconhecido'}` };
  }
  if ('motivo' in recibo) return { atual, recibo, ...vazio };
  return fatosGitDoRecibo(atual, recibo, lidos);
}

/** Os fatos de git entre o merge que o recibo testou e o de agora (todos no checkout `cwd`). */
export function fatosGitDoRecibo(
  atual: MergeTestado,
  recibo: { runId: number; merge: MergeTestado },
  lidos: ReadonlySet<string> | null,
  cwd?: string,
): FatosRecibo {
  const r = recibo.merge;
  return {
    atual,
    recibo,
    headAncestral: ehAncestral(r.head, atual.head, cwd),
    baseAncestral: ehAncestral(r.base, atual.base, cwd),
    merges: contaMerges(r.head, atual.head, cwd),
    forkRecibo: mergeBase(r.base, r.head, cwd),
    forkAtual: mergeBase(atual.base, atual.head, cwd),
    arvoreRecalculada: arvoreDoMerge(r.base, r.head, cwd),
    diffHead: diffComModo(r.head, atual.head, cwd)?.map((e) => e.caminho) ?? null,
    diffArvore: diffComModo(r.tree, atual.tree, cwd),
    lidos,
  };
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
      alvo: (p) => {
        try {
          if (!lstatSync(p).isSymbolicLink()) return null;
          return posix.normalize(posix.join(posix.dirname(p), readlinkSync(p)));
        } catch {
          return null;
        }
      },
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
  /** Por que pulou: `inerte` (PR), `recibo` (PR, com `recibo`) ou `main-docs` (E14). Vazio quando roda. */
  let modo = '';
  let recibo: number | undefined;
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
      modo = d.roda ? '' : 'main-docs';
      for (const m of d.motivos) console.log(`  · ${m}`);
    } else {
      let mudados: string[] | null = null;
      const pr = Number(arg('--pr'));
      const prValido = Number.isSafeInteger(pr) && pr > 0;
      // O merge commit que ESTE run testa, deixado como anotação: é o que um push futuro do mesmo PR
      // lê (pela API de check-runs) para reaproveitar este resultado. Só no CI (`--pr`), sem `--base`.
      const atual = evento === 'pull_request' && prValido && !arg('--base') ? mergeDoCheckout() : null;
      if (atual) console.log(anotacaoRecibo(pr, atual));
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
      modo = d.roda ? '' : 'inerte';
      for (const m of d.motivos) console.log(`  · ${m}`);
      // O PR toca o que as provas leem: um run anterior do MESMO PR já provou isso?
      const headRef = arg('--head-ref') ?? '';
      if (roda && atual && mudados !== null && mudados.length > 0 && headRef !== '') {
        const r = decidirRecibo(
          fatosDoRecibo(arg('--repo') ?? '', Number(arg('--run-id')), headRef, pr, atual, lidos),
        );
        for (const m of r.motivos) console.log(`  · ${m}`);
        if (!r.roda && r.recibo !== undefined) {
          roda = false;
          modo = 'recibo';
          recibo = r.recibo;
        }
      }
    }
    console.log(
      roda
        ? 'provas-sql-escopo: RODA o núcleo inteiro.'
        : modo === 'recibo'
          ? `provas-sql-escopo: REAPROVEITA as provas do run ${recibo} — provas-sql e a união ficam puladas.`
          : 'provas-sql-escopo: nada que as provas leem — provas-sql e a união ficam puladas.',
    );
  } catch (e) {
    roda = true;
    base = undefined;
    modo = '';
    recibo = undefined;
    console.log(`::warning::provas-sql-escopo não decidiu (${mensagemDeErro(e) ?? 'erro desconhecido'}) — roda TUDO.`);
  }
  if (querSaida) {
    try {
      if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT ausente');
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `roda=${roda}\n${base ? `base=${base}\n` : ''}${!roda && modo ? `modo=${modo}\n` : ''}${!roda && recibo ? `recibo=${recibo}\n` : ''}`,
      );
    } catch (e) {
      // Saída ausente: a condição do `provas-sql` (`roda != 'false'`) roda mesmo assim.
      console.log(`::warning::sem saída do escopo (${mensagemDeErro(e) ?? 'erro desconhecido'}) — o provas-sql roda.`);
    }
  }
  process.exit(0);
}
