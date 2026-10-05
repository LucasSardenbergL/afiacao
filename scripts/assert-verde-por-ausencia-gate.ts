#!/usr/bin/env bun
/**
 * assert-verde-por-ausencia-gate.ts — fiscal TEXTUAL do assert de prova PG17 que PASSA quando o valor
 * medido está AUSENTE. Não executa SQL nenhum.
 *
 *   bun scripts/assert-verde-por-ausencia-gate.ts              # todo shell E todo .sql de db/ (PISOS + catraca)
 *   bun scripts/assert-verde-por-ausencia-gate.ts <dir…>       # corpo arbitrário (sem piso nem catraca — é fixture)
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
 * ## As regras — só as que têm forma canônica MECÂNICA
 *
 * 1. `diferente` (v1): `<>`/`!=` em NÍVEL BOOLEANO da condição. Conserto: `IS DISTINCT FROM` — NULL
 *    contra um valor vira TRUE. É drop-in: precedência mais fraca que aritmética, `::`, `->>` e `||`,
 *    mais forte que NOT/AND/OR.
 * 2. `json-bool` (v2): o ESPELHO de chave JSON — átomo `(r->>'k')::boolean` nu, com NOT, ou com
 *    `IS TRUE`/`IS FALSE`/`= true`/`= false`. Com a chave SUMIDA o átomo é NULL (ou FALSE no IS) e o
 *    assert não dispara (o `deduped` do radar). Conserto: `IS NOT FALSE` (esperado false) /
 *    `IS NOT TRUE` (esperado true).
 * 3. `coalesce` (v2): o COALESCE que FABRICA o esperado — `coalesce(v, L) IS DISTINCT FROM L` (ou
 *    `<>`/`!=` L). Com v NULL vira L contra L e passa: o conserto da regra 1 aplicado a
 *    `coalesce(v,L) <> L` seguia cego. Conserto: medir v sem o COALESCE, ou um sentinela que NÃO seja o
 *    esperado (o `'ERA_NULL'` de test-cap-carteira-escrever-master-only).
 *
 * ## A assinatura, e o que fica de fora de propósito
 *
 * O assert = IF/ELSIF/ELSEIF cujo THEN começa (depois de comentário SQL) por RAISE — EXCEPTION, `'msg'`
 * (o nível padrão É exception), USING, SQLSTATE ou `<condição>;`, nunca NOTICE/WARNING/INFO/LOG/DEBUG —,
 * por um ACUMULADOR de falha (`x := x + …`, `x := x || …`, `x := array_append(x, …)`, também com `=`)
 * ou por INSERT INTO (registro de falha). Nível booleano = fora de string SQL, de comentário `--`, de
 * SUBCONSULTA (parêntese que abre com SELECT/WITH/VALUES: lá o `<>` é FILTRO, e trocá-lo mudaria o
 * conjunto) e de ARGUMENTO DE FUNÇÃO (`coalesce(a <> b, true)` já é uma guarda de NULL). Só em bloco DO
 * e em função `pg_temp.*` (o helper da própria prova): corpo de CREATE FUNCTION pública é
 * fixture/código sob teste — trocar ali mudaria o produto simulado.
 *
 * NÃO há isenção por "o operando vem de count(*) e nunca é NULL": a regra é absoluta de propósito —
 * idioma único (arquivo misto ensina o padrão errado a quem copia) e nenhuma análise de fluxo, que é
 * onde um fiscal textual erra em silêncio. `IS DISTINCT FROM` é neutro com operandos não-NULL.
 *
 * As formas SEM forma canônica mecânica ficam fora, com a assinatura em docs/agent/money-path.md e no
 * histórico: `IF NOT flag` e ordem (`IF n < 1` de count teria de virar `(n >= 1) IS NOT TRUE`), o
 * esperado NULL lido de record sem prova da linha (`NOT FOUND OR`), a contagem universal com filtro
 * NULL-cego (precisa do denominador), o "ok por omissão" em bash e a forma `eq … "$(leitura)" ""`.
 *
 * A única isenção é comentário: de SHELL nos .sh — e quem a decide é o stripper COMPARTILHADO: `#`
 * dentro de aspas ou de heredoc é dado (o `#>>` do jsonb, inclusive), e uma regex local apagaria
 * justamente a linha que o fiscal existe para ler (docs/historico/gates-textuais-cegos.md) —; e de SQL
 * nos .sql, pelo `limparSql` abaixo (não há stripper SQL compartilhado; o de TS não serve).
 *
 * ## db/*.sql — a catraca
 *
 * Os sítios de .sql que já existem moram em scripts APLICADOS em produção pelo `db:aplicar`, que guarda
 * o sha256 dos bytes no ledger: reescrevê-los quebraria "recibo = bytes do repo" e faria o arquivo
 * parecer pendente de apply. A CATRACA_SQL congela a contagem por arquivo: .sql novo nasce limpo, e a
 * contagem de um arquivo listado não sobe — nem desce sem atualizar a catraca (senão a folga escondia o
 * próximo).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { diagnosticarShell, removerComentariosShell } from '@/lib/gates/limpeza-shell';
import { drenar, type Passos } from '@/lib/gates/passos';
import { alarmesDoStripper, enumerar } from './shell-variavel-colada-gate';

/** `import.meta.dir` é do Bun e não existe sob o vitest — por isso preguiçosa, como nos irmãos. */
const raizDoRepo = () => resolve(import.meta.dir, '..');

/** O walker e os alarmes do stripper vêm do irmão `shell-variavel-colada-gate.ts`, não são copiados. */
export const RAIZES_PADRAO = ['db'];

/**
 * PISOS — o denominador do fiscal, medido em 2026-09-30 (319 shells em db/) e 2026-10-01 (110 .sql).
 * Piso é alarme de fumaça: folgado abaixo do medido, SOBE quando o repo cresce, nunca desce para caber.
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
  /** Os .sql de db/ (raiz e subpastas). Medido: 110. */
  arquivosSql: 90,
  /** IF-asserts reconhecidos nos .sql — o sensor de cegueira do lado SQL. Medido: 125. */
  assertsSql: 100,
} as const;

/**
 * A catraca dos .sql (ver o cabeçalho): sítios por arquivo, medidos em 2026-10-01. Todos em scripts de
 * apply/reparo/diagnóstico já executados — o conserto deles é o próximo arquivo nascer limpo.
 */
export const CATRACA_SQL: Readonly<Record<string, number>> = {
  'db/aplicar-cancelar-orfa-4c19af2a.sql': 7,
  'db/aplicar-data-health-sync-reprocess-saude.sql': 8,
  'db/aplicar-desconto-escritores.sql': 1,
  'db/aplicar-religar-reposicao-15-skus.sql': 4,
  'db/aplicar-sonda-alvos-onda3.sql': 1,
  'db/aplicar-sonda-alvos-onda4.sql': 1,
  'db/aplicar-sonda-alvos-onda5.sql': 1,
  'db/aplicar-sync-reprocess-degradado-vigiadas.sql': 1,
  'db/embalagem-motor-rpc.sql': 2,
  'db/reparo-15o-pedido-11701.sql': 7,
  'db/reparo-passivo-coerencia-pedido-venda.sql': 3,
};

const PROVA = /^db\/test-[^/]*\.sh$/;

/** IF/ELSIF/ELSEIF em qualquer caixa: o PL/pgSQL das provas é escrito dos dois jeitos. */
const PALAVRA_IF = /\b(ELSIF|ELSEIF|IF)\b/gi;
const THEN_ = /\bTHEN\b/i;
/** O rabo que faz do IF um ASSERT (o que vem logo depois do THEN — e do comentário SQL, se houver). */
const RABO_ASSERT =
  /^\s*(?:RAISE\s+EXCEPTION\b|RAISE\s+(?:'|USING\b|SQLSTATE\b|(?!(?:NOTICE|WARNING|INFO|LOG|DEBUG|EXCEPTION)\b)[A-Za-z_]\w*\s*(?:;|USING\b))|([A-Za-z_][A-Za-z_0-9]*)\s*:?=\s*(?:\1\s*(?:\+|\|\|)|array_append\s*\(\s*\1\b)|INSERT\s+INTO\b)/i;
/** Comentário SQL no começo do rabo (`THEN -- motivo\n RAISE …`): o assert continua sendo assert. */
const COMENTARIO_INICIAL = /^(?:\s|--[^\n]*)*/;
/** Início de bloco: `DO $x$` (com o `$` escapado ou não, tag com dígito) ou CREATE FUNCTION/PROCEDURE. */
const INICIO_DE_BLOCO =
  /\bDO\s*(?:LANGUAGE\s+plpgsql\s*)?(\\?\$[A-Za-z_0-9]*\\?\$)|\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+([A-Za-z_0-9."]+)/gi;
/** Janela máxima entre o IF e o seu THEN (a maior condição medida tem ~600 caracteres). */
const JANELA_DA_CONDICAO = 1200;

/** `diferente` = `<>`/`!=` (v1) · `json-bool` = espelho de chave JSON · `coalesce` = o default é o esperado. */
export type Regra = 'diferente' | 'json-bool' | 'coalesce';

export interface Sitio {
  arquivo: string;
  linha: number;
  /** a condição inteira numa linha, do IF ao THEN (≤ 160 caracteres) */
  trecho: string;
  /** `diferente`: quantos `<>`/`!=`; as outras regras: quantos átomos */
  operadores: number;
  regra: Regra;
}

export interface Analise {
  caminhos: string[];
  linhasDeCodigo: number;
  asserts: number;
  violacoes: Sitio[];
  alarmes: string[];
  /** o lado .sql: os arquivos lidos, os asserts reconhecidos e os sítios (que a catraca julga) */
  caminhosSql: string[];
  assertsSql: number;
  sitiosSql: Sitio[];
}

type Nivel = 'booleano' | 'subconsulta' | 'funcao';

/** Pula a string SQL que abre em `i` ('' é a aspa escapada); devolve o índice depois do fecho. */
function fimDaString(s: string, i: number, fim: number): number {
  let j = i + 1;
  while (j < fim) {
    if (s[j] === "'") {
      if (s[j + 1] === "'") { j += 2; continue; }
      break;
    }
    j++;
  }
  return j + 1;
}

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

/**
 * Os átomos de nível 0 de `s[ini, fim)`: a condição partida nos AND/OR que estão FORA de string, de
 * comentário e de parêntese. Cada átomo vem aparado.
 */
export function atomosDaCondicao(s: string, ini: number, fim: number): string[] {
  const atomos: string[] = [];
  let prof = 0;
  let inicio = ini;
  let i = ini;
  while (i < fim) {
    const c = s[i];
    if ("'" === c) { i = fimDaString(s, i, fim); continue; }
    if (s.startsWith('--', i)) {
      const nl = s.indexOf('\n', i);
      i = nl < 0 || nl > fim ? fim : nl;
      continue;
    }
    if (c === '(') prof++;
    else if (c === ')') prof--;
    else if (prof === 0) {
      const m = /^\s(AND|OR)\s/i.exec(s.slice(i, Math.min(fim, i + 5)));
      if (m) {
        atomos.push(s.slice(inicio, i).trim());
        i += m[0].length - 1;
        inicio = i;
        continue;
      }
    }
    i++;
  }
  atomos.push(s.slice(inicio, fim).trim());
  return atomos.filter((a) => a !== '');
}

/** Tira os parênteses que embrulham o átomo INTEIRO (`((x))` → `x`), nunca os de um pedaço dele. */
function semParentesesDeFora(a: string): string {
  let t = a.trim();
  for (;;) {
    if (!t.startsWith('(') || !t.endsWith(')')) return t;
    let prof = 0;
    let embrulha = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "'") { i = fimDaString(t, i, t.length) - 1; continue; }
      if (t[i] === '(') prof++;
      else if (t[i] === ')') prof--;
      if (prof === 0 && i < t.length - 1) { embrulha = false; break; }
    }
    if (!embrulha) return t;
    t = t.slice(1, -1).trim();
  }
}

/** `(r->>'k')::boolean` (com caminho `->'a'->>'b'`) nu, com NOT, ou com IS TRUE/IS FALSE/= true/= false. */
const CHAVE_JSON_BOOL =
  /^\(\s*[A-Za-z_][\w.]*(?:\s*->\s*'[^']*')*\s*->>\s*'[^']*'\s*\)\s*::\s*bool(?:ean)?(?:\s+IS\s+(?:TRUE|FALSE)|\s*=\s*(?:TRUE|FALSE))?$/i;

/** Os átomos da condição que são o ESPELHO de chave JSON (regra 2). */
export function espelhosDeChaveJson(s: string, ini: number, fim: number): string[] {
  return atomosDaCondicao(s, ini, fim).filter((a) => {
    let t = semParentesesDeFora(a);
    const not = /^NOT\b/i.exec(t);
    if (not) t = semParentesesDeFora(t.slice(not[0].length));
    return CHAVE_JSON_BOOL.test(t);
  });
}

/** Literal normalizado para comparar o default do COALESCE com o esperado: sem cast, sem caixa. */
function literal(t: string): string | null {
  const m = /^\s*('(?:[^']|'')*'|-?\d+(?:\.\d+)?|true|false)\s*(?:::\s*[A-Za-z_][\w ]*(?:\[\])?)?\s*$/i.exec(t);
  return m ? m[1].toLowerCase() : null;
}

/** Os átomos `coalesce(v, L) IS DISTINCT FROM L` (ou `<>`/`!=` L) da condição (regra 3). */
export function coalescesQueFabricam(s: string, ini: number, fim: number): string[] {
  return atomosDaCondicao(s, ini, fim).filter((a) => {
    const t = semParentesesDeFora(a);
    const m = /^coalesce\s*\(/i.exec(t);
    if (!m) return false;
    // o parêntese que fecha o COALESCE e o último argumento dele (o default)
    let prof = 1;
    let ultimaVirgula = m[0].length - 1;
    let i = m[0].length;
    for (; i < t.length && prof > 0; i++) {
      if (t[i] === "'") { i = fimDaString(t, i, t.length) - 1; continue; }
      if (t[i] === '(') prof++;
      else if (t[i] === ')') prof--;
      else if (t[i] === ',' && prof === 1) ultimaVirgula = i;
    }
    if (prof !== 0) return false;
    const padrao = literal(t.slice(ultimaVirgula + 1, i - 1));
    const resto = /^\s*(?:::\s*[A-Za-z_][\w ]*?(?:\[\])?\s*)?(?:IS\s+DISTINCT\s+FROM|<>|!=)\s*(.+)$/is.exec(t.slice(i));
    return padrao !== null && resto !== null && literal(resto[1]) === padrao;
  });
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

/** Cada IF/ELSIF/ELSEIF-ASSERT de bloco DO: [início da palavra IF, início e fim da condição]. */
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
    const rabo = s.slice(fim + t[0].length, fim + t[0].length + 400);
    if (!RABO_ASSERT.test(rabo.replace(COMENTARIO_INICIAL, ''))) continue;
    while (b + 1 < bs.length && bs[b + 1].pos < kw) b++;
    if (b < 0 || !bs[b].ehAssert) continue; // fora de bloco, ou corpo de função pública (fixture)
    r.push({ kw, ini, fim });
  }
  return r;
}

/** As três regras sobre um texto JÁ limpo de comentário (shell ou SQL). */
function detectarLimpo(caminho: string, limpo: string): { sitios: Sitio[]; asserts: number; linhasDeCodigo: number } {
  const linhasDeCodigo = limpo.split('\n').filter((l) => l.trim() !== '').length;
  const sitios: Sitio[] = [];
  const as = assertsDoArquivo(limpo);
  for (const a of as) {
    const achados: [Regra, number][] = [
      ['diferente', operadoresEmNivelBooleano(limpo, a.ini, a.fim).length],
      ['json-bool', espelhosDeChaveJson(limpo, a.ini, a.fim).length],
      ['coalesce', coalescesQueFabricam(limpo, a.ini, a.fim).length],
    ];
    for (const [regra, n] of achados) {
      if (n === 0) continue;
      sitios.push({
        arquivo: caminho,
        linha: limpo.slice(0, a.kw).split('\n').length,
        trecho: limpo.slice(a.kw, a.fim).replace(/\s+/g, ' ').trim().slice(0, 160),
        operadores: n,
        regra,
      });
    }
  }
  return { sitios, asserts: as.length, linhasDeCodigo };
}

export function detectar(caminho: string, fonte: string): { sitios: Sitio[]; asserts: number; linhasDeCodigo: number } {
  // A limpeza preserva o número de linhas: o índice aqui é a linha da FONTE.
  const limpo = removerComentariosShell(fonte);
  return detectarLimpo(caminho, limpo);
}

/**
 * Comentário SQL (`--` até o fim da linha, `/* … *\/`) vira espaço FORA de string `'…'` — preserva o
 * número de linhas. `fechou` = falso quando o arquivo acaba DENTRO de string ou comentário de bloco
 * (o limpador perdeu o compasso: o que veio depois não é confiável).
 */
export function limparSql(fonte: string): { limpo: string; fechou: boolean } {
  let out = '';
  let i = 0;
  while (i < fonte.length) {
    const c = fonte[i];
    if (fonte[i] === "'") {
      const f = fimDaString(fonte, i, fonte.length);
      if (f > fonte.length) return { limpo: out + fonte.slice(i), fechou: false };
      out += fonte.slice(i, f);
      i = f;
      continue;
    }
    if (c === '-' && fonte[i + 1] === '-') {
      const nl = fonte.indexOf('\n', i);
      const f = nl < 0 ? fonte.length : nl;
      out += ' '.repeat(f - i);
      i = f;
      continue;
    }
    if (c === '/' && fonte[i + 1] === '*') {
      const fecho = fonte.indexOf('*/', i + 2);
      if (fecho < 0) return { limpo: out + fonte.slice(i).replace(/[^\n]/g, ' '), fechou: false };
      out += fonte.slice(i, fecho + 2).replace(/[^\n]/g, ' ');
      i = fecho + 2;
      continue;
    }
    out += c;
    i++;
  }
  return { limpo: out, fechou: true };
}

export function detectarSql(caminho: string, fonte: string): { sitios: Sitio[]; asserts: number; fechou: boolean } {
  const { limpo, fechou } = limparSql(fonte);
  const d = detectarLimpo(caminho, limpo);
  return { sitios: d.sitios, asserts: d.asserts, fechou };
}

export function analisar(arquivos: { caminho: string; fonte: string }[]): Analise {
  return drenar(analisarPassos(arquivos));
}

/** A análise como gerador (`@/lib/gates/passos`): `yield` por arquivo (no TOPO do laço — o ramo `.sql`
 *  sai por `continue`) — o teste que varre o repo inteiro drena cedendo o event loop do worker do
 *  vitest (o RPC estoura com >60s de bloqueio: docs/historico/rpc-do-vitest-e-o-loop-preso.md). */
export function* analisarPassos(arquivos: { caminho: string; fonte: string }[]): Passos<Analise> {
  const r: Analise = {
    caminhos: [], linhasDeCodigo: 0, asserts: 0, violacoes: [], alarmes: [], caminhosSql: [], assertsSql: 0, sitiosSql: [],
  };
  for (const a of arquivos) {
    yield;
    if (a.caminho.endsWith('.sql')) {
      const d = detectarSql(a.caminho, a.fonte);
      r.caminhosSql.push(a.caminho);
      r.assertsSql += d.asserts;
      r.sitiosSql.push(...d.sitios);
      if (!d.fechou) r.alarmes.push(`${a.caminho}: o limpador SQL terminou dentro de string ou comentário`);
      continue;
    }
    const d = detectar(a.caminho, a.fonte);
    r.caminhos.push(a.caminho);
    r.linhasDeCodigo += d.linhasDeCodigo;
    r.asserts += d.asserts;
    r.violacoes.push(...d.sitios);
    r.alarmes.push(...alarmesDoStripper(a.caminho, diagnosticarShell(a.fonte)));
  }
  return r;
}

/** Os .sql sob cada raiz, recursivo, em ordem estável. */
export function enumerarSql(raizes: string[], base: string): string[] {
  const out: string[] = [];
  const andar = (dir: string) => {
    for (const e of readdirSync(dir).sort()) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) andar(p);
      else if (e.endsWith('.sql')) out.push(p);
    }
  };
  for (const r of raizes) andar(resolve(base, r));
  return out;
}

/** A catraca: o que passou do congelado (ou nasceu num .sql novo), o que baixou e a entrada órfã. */
export function confrontarCatraca(sitiosSql: Sitio[], caminhosSql: string[], catraca: Readonly<Record<string, number>>): string[] {
  const porArquivo = new Map<string, number>();
  for (const s of sitiosSql) porArquivo.set(s.arquivo, (porArquivo.get(s.arquivo) ?? 0) + 1);
  const furos: string[] = [];
  for (const [arq, n] of porArquivo) {
    const teto = catraca[arq] ?? 0;
    if (n > teto) {
      const novos = sitiosSql.filter((s) => s.arquivo === arq).map((s) => `${arq}:${s.linha} [${s.regra}] ${s.trecho}`);
      furos.push(`${arq}: ${n} sítio(s), a catraca permite ${teto} — .sql novo nasce limpo:`, ...novos.map((x) => `      ${x}`));
    }
  }
  for (const [arq, teto] of Object.entries(catraca)) {
    const n = porArquivo.get(arq) ?? 0;
    if (!caminhosSql.includes(arq)) furos.push(`${arq}: está na CATRACA_SQL mas não foi lido (sumiu?) — tire-o da catraca`);
    else if (n < teto) furos.push(`${arq}: ${n} sítio(s) < catraca ${teto} — baixou: atualize a CATRACA_SQL para ${n}`);
  }
  return furos;
}

export function veredito(
  r: Analise,
  comPisos: boolean,
  catracaSql: Readonly<Record<string, number>> = CATRACA_SQL,
): { codigo: 0 | 1 | 2; linhas: string[] } {
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
    if (r.caminhosSql.length < PISOS.arquivosSql) furos.push(`${r.caminhosSql.length} .sql de db/ lido(s) < piso ${PISOS.arquivosSql}`);
    if (r.assertsSql < PISOS.assertsSql) {
      furos.push(`${r.assertsSql} assert(s) reconhecido(s) nos .sql < piso ${PISOS.assertsSql} — o detector ficou cego?`);
    }
  }
  if (furos.length > 0) {
    return {
      codigo: 2,
      linhas: ['❌ INDETERMINADO — o fiscal não conseguiu medir (isto NÃO é "limpo"):', ...furos.map((f) => `  · ${f}`)],
    };
  }
  // Sem catraca (corpo arbitrário, é fixture), sítio de .sql é violação como o de shell.
  const violacoes = comPisos ? r.violacoes : [...r.violacoes, ...r.sitiosSql];
  const catraca = comPisos ? confrontarCatraca(r.sitiosSql, r.caminhosSql, catracaSql) : [];
  if (violacoes.length > 0 || catraca.length > 0) {
    const ops = violacoes.reduce((n, s) => n + s.operadores, 0);
    const da = (regra: Regra) => violacoes.filter((s) => s.regra === regra);
    return {
      codigo: 1,
      linhas: [
        `❌ ${violacoes.length} assert(s) de prova que passam com o valor AUSENTE (${ops} operador(es)/átomo(s)):`,
        ...violacoes.map((s) => `  ${s.arquivo}:${s.linha} [${s.regra}]\n      ${s.trecho}`),
        ...(catraca.length > 0 ? ['', '❌ catraca dos .sql de db/:', ...catraca.map((c) => `  ${c}`)] : []),
        '',
        '  Em PL/pgSQL, `IF v <> x THEN RAISE` com v NULL (a linha sumiu, a chave JSON faltou, a subconsulta',
        '  não achou nada) avalia NULL e o RAISE NÃO dispara: o assert aprova sem medir.',
        '  [diferente] Conserto: `IF v IS DISTINCT FROM x THEN RAISE` — drop-in, e NULL passa a reprovar. Vale também',
        '  quando v vem de count(*) (idioma único; o fiscal não faz análise de fluxo, de propósito). `<> ALL(…)`',
        '  não tem drop-in: escreva `IF x IS NULL OR x = ANY(…)` (o NULL de dentro do array segue cego).',
        ...(da('json-bool').length > 0
          ? ['  [json-bool] `(r->>\'k\')::boolean` com a chave SUMIDA é NULL: `IS NOT FALSE` (esperado false) ou',
             '  `IS NOT TRUE` (esperado true) — IS TRUE/IS FALSE/= também passam com a ausência.']
          : []),
        ...(da('coalesce').length > 0
          ? ['  [coalesce] o default do COALESCE é o próprio esperado: v NULL vira L contra L e passa. Meça v sem',
             "  o COALESCE (`IS DISTINCT FROM`) ou com um sentinela que não seja o esperado ('ERA_NULL')."]
          : []),
        '  docs/historico/assert-verde-por-ausencia.md',
      ],
    };
  }
  const censo = comPisos ? ` (${provas} provas)` : '';
  return {
    codigo: 0,
    linhas: [
      `✅ assert verde por ausência: ${r.caminhos.length} arquivo(s) shell${censo}, ${r.asserts} assert(s) de bloco DO, ` +
        `${r.linhasDeCodigo} linhas de código lidas; ${r.caminhosSql.length} .sql, ${r.assertsSql} assert(s) ` +
        `(${r.sitiosSql.length} sítio(s) congelado(s) na catraca). Nenhum assert que passe com a ausência.`,
    ],
  };
}

function main(): number {
  const argv = process.argv.slice(2);
  const usaPadrao = argv.length === 0;
  const base = usaPadrao ? raizDoRepo() : process.cwd();
  const raizes = usaPadrao ? RAIZES_PADRAO : argv;
  const arquivos = [...enumerar(raizes, base), ...enumerarSql(raizes, base)].map((c) => ({
    caminho: relative(base, c),
    fonte: readFileSync(c, 'utf8'),
  }));
  const { codigo, linhas } = veredito(analisar(arquivos), usaPadrao);
  if (codigo === 0) console.log(linhas.join('\n'));
  else console.error(linhas.join('\n'));
  return codigo;
}

if (import.meta.main) process.exit(main());
