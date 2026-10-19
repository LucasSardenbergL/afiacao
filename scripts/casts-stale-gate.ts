#!/usr/bin/env bun
/**
 * casts-stale-gate.ts — `bun run casts:stale`: `.from('x' as never)` / `.rpc('x' as never)` sobre um
 * nome que `src/integrations/supabase/types.ts` JÁ tipa é cast velho, e cast velho cega o typecheck.
 * ================================================================================================
 *
 * A classe (M-28 do plano `docs/superpowers/plans/2026-09-05-plano-melhorias-codebase/README.md`,
 * achado do `anexos/relatorio-dominio.md`): o `as never` nasce legítimo quando a tabela/RPC ainda não
 * está no `types.ts` (migration aplicada à mão, types regenerado depois). Só que ele nunca morre: o
 * types é regenerado, o nome passa a existir, e o cast continua desligando a checagem de coluna,
 * argumento e retorno. Foi por esse buraco que telas roteadas sobre objetos que NÃO EXISTEM em prod
 * (`fila_aplicacao_omie`, `quality_checklists` — M-06) passaram verdes no typecheck: com o cast,
 * nome que existe e nome que não existe têm a mesma cara.
 *
 * O gate: conta os casts `as never` sobre LITERAL cujo nome está em Tables∪Views (para `.from`) ou
 * em Functions (para `.rpc`) do schema `public`, e exige que a contagem seja IGUAL à baseline de
 * `scripts/casts-stale-baseline.json` (2026-10-11: 49 + 48; 2026-10-18, plano v2 item 4: 30 + 37). Cast velho NOVO → vermelho.
 * Cast removido → vermelho também, pedindo para baixar o número no MESMO PR: é ratchet, a baseline
 * só desce. Este PR não remove casts (a remoção é trabalho de módulo, com o typecheck dizendo o que
 * o cast escondia).
 *
 * Fora do escopo, de propósito: cast sobre VARIÁVEL (`.from(nome as never)`) e o `as never` sobre
 * nome que o types NÃO tem — esse é o uso legítimo (ou é o M-06, que tem PR próprio).
 *
 * Contra cegueira (`docs/historico/gates-textuais-cegos.md`): comentário sai pelo stripper
 * compartilhado `removerComentarios` (preserva strings — o literal sobrevive; há
 * `.from('tabela' as never)` DENTRO de comentário em src/hooks/useTarefasFase2.ts). E PISOS: types
 * lido com menos nomes, src com menos arquivos ou varredura com menos casts do que o piso não é
 * "nada a reprovar", é o gate cego, e sai ≠ 0.
 *
 * Uso: bun run casts:stale            # o CI roda (job gates-e-falsificacao)
 *      bun scripts/casts-stale-gate.ts --json
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { removerComentarios } from '../src/lib/gates/limpeza-fonte';

export const ARQ_TYPES = 'src/integrations/supabase/types.ts';
export const ARQ_BASELINE = 'scripts/casts-stale-baseline.json';

/**
 * Medidos em 2026-10-11: 354 tabelas + 87 views, 316 funções, ~2.400 fontes, 57 + 50 casts literais.
 * `castsLiterais` é RATCHET junto com a baseline (plano v2, item 4): o piso É a contagem real de casts
 * literais `as never` no src/ — remover cast exige baixar o piso no MESMO PR (senão o gate acusa
 * varredura cega), e o piso nunca sobe. 2026-10-18: 67 (reposição + pedidos programados sem cast).
 */
export const PISOS = { relacoes: 200, funcoes: 150, arquivos: 1000, castsLiterais: 67 } as const;

export interface Nomes {
  relacoes: Set<string>; // Tables ∪ Views
  funcoes: Set<string>;
}

/**
 * Lê os nomes das seções `Tables`/`Views`/`Functions` do schema `public`. Por indentação, que é o
 * formato fixo do gerador do Supabase: seção com 4 espaços, entrada com 6.
 */
export function nomesTipados(types: string): Nomes {
  const linhas = types.split('\n');
  const inicioPublic = linhas.findIndex((l) => /^ {2}public: \{/.test(l));
  const relacoes = new Set<string>();
  const funcoes = new Set<string>();
  if (inicioPublic < 0) return { relacoes, funcoes };
  let secao: 'rel' | 'fn' | null = null;
  for (let i = inicioPublic + 1; i < linhas.length; i++) {
    const l = linhas[i];
    if (/^ {2}\S/.test(l)) break; // fim do bloco `public`
    const s = /^ {4}(\w+): \{/.exec(l);
    if (s) {
      secao = s[1] === 'Tables' || s[1] === 'Views' ? 'rel' : s[1] === 'Functions' ? 'fn' : null;
      continue;
    }
    const e = /^ {6}(\w+):/.exec(l);
    if (e && secao === 'rel') relacoes.add(e[1]);
    else if (e && secao === 'fn') funcoes.add(e[1]);
  }
  return { relacoes, funcoes };
}

export interface Cast {
  tipo: 'from' | 'rpc';
  nome: string;
  arquivo: string;
  linha: number;
}

const RE_CAST = /\.(from|rpc)\(\s*(["'`])([\w.]*)\2\s*as\s+never\b/g;

/** Todo `.from|.rpc(<literal> as never)` FORA de comentário. */
export function acharCasts(fonte: string, arquivo: string): Cast[] {
  const limpa = removerComentarios(fonte);
  const out: Cast[] = [];
  for (const m of limpa.matchAll(RE_CAST)) {
    const linha = limpa.slice(0, m.index).split('\n').length;
    out.push({ tipo: m[1] as 'from' | 'rpc', nome: m[3], arquivo, linha });
  }
  return out;
}

export function ehVelho(c: Cast, n: Nomes): boolean {
  return c.tipo === 'from' ? n.relacoes.has(c.nome) : n.funcoes.has(c.nome);
}

function listarFontes(raiz: string, dir: string, acc: string[]): string[] {
  for (const nome of readdirSync(join(raiz, dir))) {
    const rel = join(dir, nome);
    if (statSync(join(raiz, rel)).isDirectory()) listarFontes(raiz, rel, acc);
    else if (/\.(ts|tsx)$/.test(nome) && rel !== ARQ_TYPES) acc.push(rel);
  }
  return acc;
}

export type Veredito =
  | { tipo: 'ok'; from: number; rpc: number }
  | { tipo: 'subiu' | 'desceu'; from: number; rpc: number; base: { from: number; rpc: number } }
  | { tipo: 'cego'; motivo: string };

export function julgar(
  velhos: Cast[],
  base: { from: number; rpc: number },
  medidas: { relacoes: number; funcoes: number; arquivos: number; castsLiterais: number },
): Veredito {
  for (const k of Object.keys(PISOS) as (keyof typeof PISOS)[]) {
    if (medidas[k] < PISOS[k]) return { tipo: 'cego', motivo: `${k} = ${medidas[k]}, abaixo do piso ${PISOS[k]}` };
  }
  const from = velhos.filter((c) => c.tipo === 'from').length;
  const rpc = velhos.filter((c) => c.tipo === 'rpc').length;
  if (from > base.from || rpc > base.rpc) return { tipo: 'subiu', from, rpc, base };
  if (from < base.from || rpc < base.rpc) return { tipo: 'desceu', from, rpc, base };
  return { tipo: 'ok', from, rpc };
}

function main(): number {
  const raiz = join(import.meta.dir, '..');
  const nomes = nomesTipados(readFileSync(join(raiz, ARQ_TYPES), 'utf8'));
  const base = JSON.parse(readFileSync(join(raiz, ARQ_BASELINE), 'utf8')) as { from: number; rpc: number };
  const fontes = listarFontes(raiz, 'src', []);
  const casts = fontes.flatMap((f) => acharCasts(readFileSync(join(raiz, f), 'utf8'), relative(raiz, join(raiz, f))));
  const velhos = casts.filter((c) => ehVelho(c, nomes));
  const v = julgar(velhos, base, {
    relacoes: nomes.relacoes.size,
    funcoes: nomes.funcoes.size,
    arquivos: fontes.length,
    castsLiterais: casts.length,
  });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ veredito: v, velhos }, null, 2));
    return v.tipo === 'ok' ? 0 : 1;
  }
  console.log(
    `casts-stale: ${fontes.length} fontes · ${nomes.relacoes.size} tabelas+views · ${nomes.funcoes.size} funções · ` +
      `${casts.length} casts literais \`as never\` · ${velhos.length} sobre nome já tipado`,
  );
  if (v.tipo === 'cego') {
    console.error(`CASTS-STALE-CEGO: ${v.motivo} — o gate não enxergou o que devia; não é "nada a reprovar".`);
    return 1;
  }
  if (v.tipo === 'subiu') {
    console.error(
      `CASTS-STALE-SUBIU: from ${v.from} (baseline ${v.base.from}) · rpc ${v.rpc} (baseline ${v.base.rpc}).\n` +
        `Cast \`as never\` NOVO sobre nome que ${ARQ_TYPES} já tipa. Tire o cast: o types conhece o nome, e o\n` +
        'cast só desliga a checagem de coluna/argumento/retorno. Sítios atuais:',
    );
    for (const c of velhos) console.error(`  ${c.arquivo}:${c.linha}  .${c.tipo}('${c.nome}' as never)`);
    return 1;
  }
  if (v.tipo === 'desceu') {
    console.error(
      `CASTS-STALE-DESCEU: from ${v.from} (baseline ${v.base.from}) · rpc ${v.rpc} (baseline ${v.base.rpc}).\n` +
        `Bom: cast velho removido. Baixe ${ARQ_BASELINE} para {"from": ${v.from}, "rpc": ${v.rpc}} neste PR (ratchet).`,
    );
    return 1;
  }
  console.log(`CASTS-STALE-OK: from ${v.from} · rpc ${v.rpc} = baseline`);
  return 0;
}

if (import.meta.main) process.exit(main());
