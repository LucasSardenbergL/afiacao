#!/usr/bin/env bun
/**
 * assert-verde-por-ausencia-gate.ts — fiscal TEXTUAL do assert de prova PG17 que PASSA quando o valor
 * medido está AUSENTE. Não executa SQL nenhum.
 *
 *   bun scripts/assert-verde-por-ausencia-gate.ts              # todo shell de db/ (com PISOS)
 *   bun scripts/assert-verde-por-ausencia-gate.ts <dir…>       # corpo arbitrário (sem piso — é fixture)
 *
 * exit 0 = limpo · 1 = violação · 2 = o fiscal não conseguiu medir (nenhum arquivo lido, piso de
 * denominador furado, stripper desabando). 2 NUNCA é "passou". Roda no CI pelo vitest
 * (`assert-verde-por-ausencia-gate.test.ts`); as mutações que provam o dente de cada camada estão em
 * `scripts/mutcheck.d/assert-verde-por-ausencia.mut`.
 *
 * ## A classe (docs/historico/assert-verde-por-ausencia.md)
 *
 * Em PL/pgSQL, `IF <cond> THEN RAISE` só dispara com a condição TRUE — NULL não dispara. O assert
 * `SELECT col INTO v … WHERE …; IF v <> 12.5 THEN RAISE …` com a linha SUMIDA (v NULL) avalia
 * `NULL <> 12.5` = NULL e PASSA: aprova sem medir nada. É o "ausente ≠ zero" do CLAUDE.md no lado do
 * teste. Caso de origem: o C1.2 de `db/test-tint-promote.sh` (`IF q900 <> 12.5`); a varredura achou
 * a forma em 42 provas (campo de record, chave JSON, subconsulta escalar, retorno de função…).
 *
 * Conserto: `IS DISTINCT FROM` — NULL contra um valor vira TRUE. É drop-in: precedência mais fraca que
 * aritmética, `::`, `->>` e `||`, mais forte que NOT/AND/OR.
 *
 * ## A assinatura, e o que fica de fora de propósito
 *
 * `<>`/`!=` em NÍVEL BOOLEANO da condição de um IF/ELSIF-ASSERT:
 *   - assert = o THEN começa por RAISE EXCEPTION, por um ACUMULADOR de falha (`x := x + …`,
 *     `x := x || …`, `x := array_append(x, …)`) ou por INSERT INTO (registro de falha);
 *   - nível booleano = fora de string SQL, de comentário `--`, de SUBCONSULTA (parêntese que abre com
 *     SELECT/WITH/VALUES: lá o `<>` é FILTRO, e trocá-lo mudaria o conjunto) e de ARGUMENTO DE FUNÇÃO
 *     (`coalesce(a <> b, true)` já é uma guarda de NULL);
 *   - só em bloco DO, e em função `pg_temp.*` (o helper da própria prova). Corpo de CREATE FUNCTION
 *     pública é fixture/código sob teste: trocar ali mudaria o produto simulado.
 *
 * NÃO há isenção por "o operando vem de count(*) e nunca é NULL": a regra é absoluta de propósito —
 * idioma único (arquivo misto ensina o padrão errado a quem copia) e nenhuma análise de fluxo, que é
 * onde um fiscal textual erra em silêncio. `IS DISTINCT FROM` é neutro com operandos não-NULL.
 *
 * As irmãs de expectativa positiva — `IF NOT flag`, ordem (`IF v >= 0`), `NOT LIKE`, `= 'null'::jsonb`
 * — ficam FORA: não têm forma canônica mecânica (`IF n < 1` de count teria de virar
 * `(n >= 1) IS NOT TRUE`). São detecção manual, com a assinatura em docs/agent/money-path.md. A forma
 * bash (`eq … "$(leitura)" ""`) também.
 *
 * A única isenção é comentário de SHELL, e quem a decide é o stripper COMPARTILHADO: `#` dentro de
 * aspas ou de heredoc é dado (o `#>>` do jsonb, inclusive) — uma regex local apagaria justamente a
 * linha que o fiscal existe para ler (docs/historico/gates-textuais-cegos.md).
 */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { diagnosticarShell, removerComentariosShell } from '@/lib/gates/limpeza-shell';
import { alarmesDoStripper, enumerar } from './shell-variavel-colada-gate';

/** `import.meta.dir` é do Bun e não existe sob o vitest — por isso preguiçosa, como nos irmãos. */
const raizDoRepo = () => resolve(import.meta.dir, '..');

/** O walker e os alarmes do stripper vêm do irmão `shell-variavel-colada-gate.ts`, não são copiados. */
export const RAIZES_PADRAO = ['db'];

/**
 * PISOS — o denominador do fiscal, medido em 2026-09-30 (319 shells em db/). Piso é alarme de fumaça:
 * folgado abaixo do medido, SOBE quando o repo cresce, nunca desce para caber.
 */
export const PISOS = {
  /** As provas, `db/test-*.sh`. Medido: 309. */
  provas: 250,
  /** Linhas de CÓDIGO lidas (não vazias, DEPOIS da limpeza). Medido: 80.707. */
  linhasDeCodigo: 60_000,
  /**
   * IF/ELSIF-ASSERT reconhecidos em bloco DO — COM ou SEM `<>`. É o sensor de cegueira do próprio
   * detector: se a regex do bloco, do THEN ou do rabo de assert apodrecer, as violações vão a zero
   * junto, e só este número diz que o zero foi CEGUEIRA. Medido: 887 (os asserts comentados, que o
   * stripper descarta, não contam).
   */
  asserts: 700,
} as const;

const PROVA = /^db\/test-[^/]*\.sh$/;

/** IF/ELSIF em qualquer caixa: o PL/pgSQL das provas é escrito dos dois jeitos. */
const PALAVRA_IF = /\b(ELSIF|IF)\b/gi;
const THEN_ = /\bTHEN\b/i;
/** O rabo que faz do IF um ASSERT (o que vem logo depois do THEN). */
const RABO_ASSERT =
  /^\s*(?:RAISE\s+EXCEPTION\b|([A-Za-z_][A-Za-z_0-9]*)\s*:=\s*(?:\1\s*(?:\+|\|\|)|array_append\s*\(\s*\1\b)|INSERT\s+INTO\b)/i;
/** Início de bloco: `DO $x$` (com o `$` escapado ou não, tag com dígito) ou CREATE FUNCTION/PROCEDURE. */
const INICIO_DE_BLOCO =
  /\bDO\s*(?:LANGUAGE\s+plpgsql\s*)?(\\?\$[A-Za-z_0-9]*\\?\$)|\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+([A-Za-z_0-9."]+)/gi;
/** Janela máxima entre o IF e o seu THEN (a maior condição medida tem ~600 caracteres). */
const JANELA_DA_CONDICAO = 1200;

export interface Sitio {
  arquivo: string;
  linha: number;
  /** a condição inteira numa linha, do IF ao THEN (≤ 160 caracteres) */
  trecho: string;
  operadores: number;
}

export interface Analise {
  caminhos: string[];
  linhasDeCodigo: number;
  asserts: number;
  violacoes: Sitio[];
  alarmes: string[];
}

type Nivel = 'booleano' | 'subconsulta' | 'funcao';

/** Posições dos `<>`/`!=` em NÍVEL BOOLEANO de `s[ini, fim)` (ver a assinatura no cabeçalho). */
export function operadoresEmNivelBooleano(s: string, ini: number, fim: number): number[] {
  const ops: number[] = [];
  const pilha: Nivel[] = [];
  let i = ini;
  while (i < fim) {
    const c = s[i];
    if (c === "'") {
      // string SQL: '' é a aspa escapada
      let j = i + 1;
      while (j < fim) {
        if (s[j] === "'") {
          if (s[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === '-' && s[i + 1] === '-') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 || nl > fim ? fim : nl;
      continue;
    }
    if (c === '(') {
      const antes = s.slice(ini, i).replace(/[ \t]+$/, '');
      const palavra = /([A-Za-z_][A-Za-z_0-9]*)$/.exec(antes)?.[1]?.toUpperCase() ?? '';
      const colado = /[A-Za-z0-9_"\]]$/.test(antes);
      if (/^\s*(SELECT|WITH|VALUES)\b/i.test(s.slice(i + 1, fim))) pilha.push('subconsulta');
      else if (colado && !['NOT', 'AND', 'OR', 'IF', 'ELSIF'].includes(palavra)) pilha.push('funcao');
      else pilha.push('booleano');
      i++;
      continue;
    }
    if (c === ')') {
      pilha.pop();
      i++;
      continue;
    }
    if ((c === '<' && s[i + 1] === '>') || (c === '!' && s[i + 1] === '=')) {
      if (pilha.every((n) => n === 'booleano')) ops.push(i);
      i += 2;
      continue;
    }
    i++;
  }
  return ops;
}

/** Os blocos do arquivo, em ordem: onde começam e se são DO (ou helper pg_temp) ou função pública. */
function blocos(s: string): { pos: number; ehAssert: boolean }[] {
  const r: { pos: number; ehAssert: boolean }[] = [];
  for (const m of s.matchAll(INICIO_DE_BLOCO)) {
    const funcao = m[2];
    r.push({ pos: m.index, ehAssert: funcao === undefined || /^pg_temp\./i.test(funcao) });
  }
  return r;
}

/** Cada IF/ELSIF-ASSERT de bloco DO: [início da palavra IF, início e fim da condição]. */
export function assertsDoArquivo(s: string): { kw: number; ini: number; fim: number }[] {
  const bs = blocos(s);
  const r: { kw: number; ini: number; fim: number }[] = [];
  let b = -1;
  for (const m of s.matchAll(PALAVRA_IF)) {
    const kw = m.index;
    if (/END\s*$/i.test(s.slice(Math.max(0, kw - 8), kw))) continue; // END IF
    const ini = kw + m[0].length;
    const t = THEN_.exec(s.slice(ini, ini + JANELA_DA_CONDICAO));
    if (!t) continue;
    const fim = ini + t.index;
    if (s.slice(ini, fim).includes(';')) continue; // não é uma condição (DDL `IF EXISTS`, bash `; then`)
    if (!RABO_ASSERT.test(s.slice(fim + t[0].length, fim + t[0].length + 200))) continue;
    while (b + 1 < bs.length && bs[b + 1].pos < kw) b++;
    if (b < 0 || !bs[b].ehAssert) continue; // fora de bloco, ou corpo de função pública (fixture)
    r.push({ kw, ini, fim });
  }
  return r;
}

export function detectar(caminho: string, fonte: string): { sitios: Sitio[]; asserts: number; linhasDeCodigo: number } {
  // A limpeza preserva o número de linhas: o índice aqui é a linha da FONTE.
  const limpo = removerComentariosShell(fonte);
  const linhasDeCodigo = limpo.split('\n').filter((l) => l.trim() !== '').length;
  const sitios: Sitio[] = [];
  const as = assertsDoArquivo(limpo);
  for (const a of as) {
    const ops = operadoresEmNivelBooleano(limpo, a.ini, a.fim);
    if (ops.length === 0) continue;
    sitios.push({
      arquivo: caminho,
      linha: limpo.slice(0, a.kw).split('\n').length,
      trecho: limpo.slice(a.kw, a.fim).replace(/\s+/g, ' ').trim().slice(0, 160),
      operadores: ops.length,
    });
  }
  return { sitios, asserts: as.length, linhasDeCodigo };
}

export function analisar(arquivos: { caminho: string; fonte: string }[]): Analise {
  const r: Analise = { caminhos: [], linhasDeCodigo: 0, asserts: 0, violacoes: [], alarmes: [] };
  for (const a of arquivos) {
    const d = detectar(a.caminho, a.fonte);
    r.caminhos.push(a.caminho);
    r.linhasDeCodigo += d.linhasDeCodigo;
    r.asserts += d.asserts;
    r.violacoes.push(...d.sitios);
    r.alarmes.push(...alarmesDoStripper(a.caminho, diagnosticarShell(a.fonte)));
  }
  return r;
}

export function veredito(r: Analise, comPisos: boolean): { codigo: 0 | 1 | 2; linhas: string[] } {
  const furos = r.alarmes.map((a) => `stripper desabando — ${a}`);
  if (r.caminhos.length === 0) furos.push('nenhum arquivo shell lido');
  const provas = r.caminhos.filter((c) => PROVA.test(c)).length;
  if (comPisos) {
    if (provas < PISOS.provas) furos.push(`${provas} prova(s) db/test-*.sh lida(s) < piso ${PISOS.provas}`);
    if (r.linhasDeCodigo < PISOS.linhasDeCodigo) {
      furos.push(`${r.linhasDeCodigo} linhas de código lidas < piso ${PISOS.linhasDeCodigo} — abriu arquivo, mas não leu código?`);
    }
    if (r.asserts < PISOS.asserts) {
      furos.push(`${r.asserts} assert(s) de bloco DO reconhecido(s) < piso ${PISOS.asserts} — o detector ficou cego?`);
    }
  }
  if (furos.length > 0) {
    return {
      codigo: 2,
      linhas: ['❌ INDETERMINADO — o fiscal não conseguiu medir (isto NÃO é "limpo"):', ...furos.map((f) => `  · ${f}`)],
    };
  }
  if (r.violacoes.length > 0) {
    const ops = r.violacoes.reduce((n, s) => n + s.operadores, 0);
    return {
      codigo: 1,
      linhas: [
        `❌ ${r.violacoes.length} assert(s) de prova com \`<>\`/\`!=\` (${ops} operador(es)) — passam com o valor AUSENTE:`,
        ...r.violacoes.map((s) => `  ${s.arquivo}:${s.linha}\n      ${s.trecho}`),
        '',
        '  Em PL/pgSQL, `IF v <> x THEN RAISE` com v NULL (a linha sumiu, a chave JSON faltou, a subconsulta',
        '  não achou nada) avalia NULL e o RAISE NÃO dispara: o assert aprova sem medir.',
        '  Conserto: `IF v IS DISTINCT FROM x THEN RAISE` — drop-in, e NULL passa a reprovar. Vale também',
        '  quando v vem de count(*) (idioma único; o fiscal não faz análise de fluxo, de propósito).',
        '  docs/historico/assert-verde-por-ausencia.md',
      ],
    };
  }
  const censo = comPisos ? ` (${provas} provas)` : '';
  return {
    codigo: 0,
    linhas: [
      `✅ assert verde por ausência: ${r.caminhos.length} arquivo(s) shell${censo}, ${r.asserts} assert(s) de bloco DO, ` +
        `${r.linhasDeCodigo} linhas de código lidas. Nenhum \`<>\`/\`!=\` em condição de assert.`,
    ],
  };
}

function main(): number {
  const argv = process.argv.slice(2);
  const usaPadrao = argv.length === 0;
  const base = usaPadrao ? raizDoRepo() : process.cwd();
  const arquivos = enumerar(usaPadrao ? RAIZES_PADRAO : argv, base).map((c) => ({
    caminho: relative(base, c),
    fonte: readFileSync(c, 'utf8'),
  }));
  const { codigo, linhas } = veredito(analisar(arquivos), usaPadrao);
  if (codigo === 0) console.log(linhas.join('\n'));
  else console.error(linhas.join('\n'));
  return codigo;
}

if (import.meta.main) process.exit(main());
