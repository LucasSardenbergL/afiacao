#!/usr/bin/env bun
/**
 * edges-afetadas.ts — quais edges o bundle MUDOU entre duas revs, pelo GRAFO e não pela pasta.
 * ============================================================================================
 *
 * ## O buraco que ele tapa
 *
 * O `--desde` do `edges-pendentes.sh` (Passo 3 do `/fecho`) enumerava por duas vias, e cada uma
 * tem um universo que a outra não cobre:
 *
 *   (a) diff de `_shared/sonda-fingerprints.ts` — enxerga mudança vinda de `_shared/`, mas só
 *       conhece quem ESTÁ no mapa (as edges com `versao.ts`);
 *   (b) `git log --name-only` das pastas — enxerga edge fora do mapa, mas não conhece o grafo de
 *       imports, então é cega para quem foi afetada sem ter a própria pasta tocada.
 *
 * A interseção dos dois furos é uma classe inteira: **edge FORA do mapa que importa `_shared/`**.
 * Ela não entra por (a) nem por (b) — não vira alvo, não vira chip, e a pendência some por
 * AUSÊNCIA DE DADO. Num script que APAGA pendência esse é o modo de falha caro
 * (`docs/historico/sonda-ausente-em-script-que-apaga.md`).
 *
 * MEDIDO em 2026-09-05 sobre `origin/main`, com a `fecharGrafo` deste mesmo módulo: das 95 pastas
 * com `index.ts`, 81 importam `_shared/` e 40 estão no mapa ⇒ **41 edges na classe cega**. A
 * `visit-score-recalc-client` foi afetada de fato na janela 2026-08-21→09-05 (por
 * `_shared/leitura-critica.ts`, 4 commits na janela) e escapou inteira.
 *
 * ## A régua
 *
 * Edge AFETADA = alguma rev do fecho transitivo dos imports locais a partir do `index.ts` aparece
 * no `git diff --name-only base..head`. Universo = toda pasta com `index.ts` no HEAD, no mapa ou
 * fora dele — é o que fecha a CLASSE em vez de fechar os 41 casos de hoje: edge nova nasce coberta.
 *
 * O fecho vem da `fecharGrafo` de `sonda-fingerprint.ts`, a MESMA que produz o campo `fonte`. É
 * de propósito: reimplementar a varredura de imports aqui criaria duas noções de "o que entra no
 * bundle" que divergem em silêncio — a razão pela qual `parsearMapa` foi extraída para lá.
 *
 * ⚠️ Herda a exclusão do `_shared/sonda-fingerprints.ts` (o fecho o omite por ser a SAÍDA do
 * gerador — ponto-fixo). Aqui isso é benigno e não é o furo de
 * `docs/historico/closure-de-hash-nao-e-lista-de-deploy.md`: aquele é sobre a fatia que o DEPLOY
 * tem de nomear; este responde "quem mudou", e mudança no mapa já entra inteira pela via (a).
 *
 * ## O sentido do erro
 *
 * Este script alimenta o lado que APAGA pendência, então erra para CIMA — nunca para baixo:
 *
 *   · falha GLOBAL (git indisponível, `base`/`head` que não resolvem, `archive` que não extrai)
 *     ⇒ exit 2, lista NENHUMA. Lista vazia por erro é indistinguível de lista vazia por mérito, e
 *     quem chama tem de tratar como mecânica não confiável;
 *   · falha LOCAL de uma edge (import que não resolve, `index.ts` ilegível) ⇒ a edge SAI COMO
 *     AFETADA, com aviso no stderr. Não medir aquela edge não pode absolvê-la.
 *
 * Uso:
 *   bun scripts/edges-afetadas.ts --base <rev> [--head <rev>] [--repo <dir>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { RAIZ_EDGES, fecharGrafo } from './sonda-fingerprint';

/** Erro que deve virar exit 2 — a mecânica não é confiável, não "não há nada". */
export class MecanicaNaoConfiavel extends Error {}

function git(repo: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    throw new MecanicaNaoConfiavel(`git ${args.join(' ')} falhou: ${mensagemDeErro(e)}`);
  }
}

/** Arquivos de `supabase/functions/` alterados entre as duas revs, relativos à raiz do repo. */
export function arquivosAlterados(repo: string, base: string, head: string): string[] {
  const saida = git(repo, ['diff', '--name-only', `${base}..${head}`, '--', RAIZ_EDGES]);
  return saida.split('\n').filter((l) => l.length > 0);
}

/** Extrai `supabase/functions/` da REV para um diretório temporário. NUNCA lê a árvore de trabalho. */
function materializar(repo: string, rev: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'edges-afetadas-'));
  try {
    const tar = execFileSync('git', ['-C', repo, 'archive', rev, RAIZ_EDGES], {
      maxBuffer: 256 * 1024 * 1024,
    });
    execFileSync('tar', ['-x', '-C', dir], { input: tar });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new MecanicaNaoConfiavel(`git archive ${rev} falhou: ${mensagemDeErro(e)}`);
  }
  return dir;
}

/** Toda pasta com `index.ts` no HEAD — no mapa ou fora dele. É o universo que fecha a CLASSE. */
export function edgesServidas(raiz: string): string[] {
  const base = resolve(raiz, RAIZ_EDGES);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((n) => n !== '_shared' && statSync(join(base, n)).isDirectory())
    .filter((n) => existsSync(join(base, n, 'index.ts')))
    .sort();
}

export interface Afetadas {
  slugs: string[];
  avisos: string[];
}

/** Cruza o fecho de cada edge servida com os arquivos alterados. Erro POR EDGE conta como afetada. */
export function calcularAfetadas(raizHead: string, alterados: string[]): Afetadas {
  // Nada alterado ⇒ ninguém afetado, nem a edge de fecho ilegível. O fail-closed abaixo existe
  // para "não sei se ESTA mudança a atingiu"; sem mudança nenhuma não há dúvida a resolver, e
  // incluí-la aqui geraria chip perpétuo — ruído com o mesmo desfecho do sinal.
  if (alterados.length === 0) return { slugs: [], avisos: [] };
  const mudou = new Set(alterados);
  const slugs: string[] = [];
  const avisos: string[] = [];
  for (const edge of edgesServidas(raizHead)) {
    let fecho: string[];
    try {
      fecho = fecharGrafo(`${RAIZ_EDGES}/${edge}/index.ts`, raizHead);
    } catch (e) {
      // Fail-CLOSED local: não conseguir medir esta edge não pode ABSOLVÊ-la.
      avisos.push(`${edge}: fecho ilegível (${mensagemDeErro(e)}) — entra como afetada`);
      slugs.push(edge);
      continue;
    }
    if (fecho.some((f) => mudou.has(f))) slugs.push(edge);
  }
  return { slugs, avisos };
}

export function main(argv: string[]): number {
  const arg = (nome: string): string | undefined => {
    const i = argv.indexOf(nome);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repo = resolve(arg('--repo') ?? process.cwd());
  const base = arg('--base');
  const head = arg('--head') ?? 'origin/main';

  if (base === undefined || base.length === 0) {
    console.error('uso: bun scripts/edges-afetadas.ts --base <rev> [--head <rev>] [--repo <dir>]');
    return 2;
  }

  let dir: string | undefined;
  try {
    const alterados = arquivosAlterados(repo, base, head);
    if (alterados.length === 0) return 0; // nada mudou em supabase/functions/ — lista vazia por MÉRITO
    dir = materializar(repo, head);
    const { slugs, avisos } = calcularAfetadas(dir, alterados);
    for (const a of avisos) console.error(`⚠️ edges-afetadas: ${a}`);
    for (const s of slugs) console.log(s);
    return 0;
  } catch (e) {
    console.error(`edges-afetadas: ${mensagemDeErro(e)}`);
    return 2;
  } finally {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
