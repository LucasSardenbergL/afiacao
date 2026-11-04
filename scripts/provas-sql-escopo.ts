#!/usr/bin/env bun
/**
 * provas-sql-escopo.ts — ESTE diff alcança alguma coisa que as provas SQL leem?
 * ============================================================================================
 *
 * O job `provas-sql` (ci.yml) roda o núcleo `db/nucleo-ci.txt` em 6 partes de ~16 min cada:
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
 * (caminho montado em variável, `find src/`) — e esse escapa só no PR: fora de PR (push/dispatch
 * da main, que o auto-merge dispara a cada merge) roda TUDO, e a main vermelha abre `ci-main-red`.
 *
 * O mapa de leitura medido (2026-11-04, sobre as 171 provas do manifesto, os 2 runners e o que
 * eles carregam transitivamente) e a medição de runner-min: docs/historico/ci-provas-sql-escopo.md.
 *
 * Fail-CLOSED em toda incerteza: evento ≠ `pull_request`, merge commit sem 2 pais, diff ilegível
 * ou VAZIO ⇒ roda. O script NUNCA sai ≠ 0 — erro vira `roda=true` — e o `provas-sql` só pula com
 * `roda` EXPLICITAMENTE 'false'; o `validate` só aceita o SKIPPED com o `success` deste job e o
 * `roda=false` dele lidos juntos.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { execFileSync } from 'node:child_process';
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
 * passe a LER um doc tem de, no mesmo PR, pôr `docs` de volta neste regex.
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
  try {
    const evento = arg('--evento') ?? 'pull_request';
    let mudados: string[] | null = null;
    if (evento === 'pull_request') {
      const base = arg('--base');
      const par = base ? { base, head: arg('--head') ?? 'HEAD' } : paisDoMerge();
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
    console.log(
      roda
        ? 'provas-sql-escopo: RODA o núcleo inteiro.'
        : 'provas-sql-escopo: nada que as provas leem — provas-sql e a união ficam puladas (a main roda TUDO).',
    );
  } catch (e) {
    roda = true;
    console.log(`::warning::provas-sql-escopo não decidiu (${mensagemDeErro(e) ?? 'erro desconhecido'}) — roda TUDO.`);
  }
  if (querSaida) {
    try {
      if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT ausente');
      appendFileSync(process.env.GITHUB_OUTPUT, `roda=${roda}\n`);
    } catch (e) {
      // Saída ausente: a condição do `provas-sql` (`roda != 'false'`) roda mesmo assim.
      console.log(`::warning::sem saída do escopo (${mensagemDeErro(e) ?? 'erro desconhecido'}) — o provas-sql roda.`);
    }
  }
  process.exit(0);
}
