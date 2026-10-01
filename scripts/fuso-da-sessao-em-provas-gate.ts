#!/usr/bin/env bun
/**
 * fuso-da-sessao-em-provas-gate.ts — fiscal TEXTUAL da prova SQL que semeia (ou calcula o esperado)
 * truncando o relógio no fuso da SESSÃO. Não executa shell nem SQL nenhum.
 *
 *   bun scripts/fuso-da-sessao-em-provas-gate.ts              # todo shell de db/ (com PISOS)
 *   bun scripts/fuso-da-sessao-em-provas-gate.ts <dir…>       # corpo arbitrário (sem piso — é fixture)
 *
 * exit 0 = limpo · 1 = violação · 2 = o fiscal não conseguiu medir (nenhum arquivo lido, piso de
 * denominador furado, stripper desabando, chamada que não fecha). 2 NUNCA é "passou". Roda no CI pelo
 * vitest (`fuso-da-sessao-em-provas-gate.test.ts`); as mutações que provam o dente de cada camada
 * estão em `scripts/mutcheck.d/fuso-da-sessao-em-provas.mut`.
 *
 * ## A classe (docs/historico/provas-janela-de-relogio-fora-do-nucleo.md)
 *
 * `date_trunc('month', now())` trunca no fuso da SESSÃO: UTC no runner do CI, São Paulo no Mac.
 * Contra uma função que calcula em America/Sao_Paulo, das 21:00 às 23:59 BRT (00:00–02:59Z) o seed
 * cai no dia SEGUINTE — e, no último dia do mês, no mês seguinte. A prova reprova sozinha numa
 * janela de 3 h que o CI só sorteia às vezes; no resto, verde cego. Caso de origem, o seed da
 * positivação antes do conserto (`db/test-positivacao-eligible-consumo.sh`, l.145-146):
 *   ('aaaaaaaa-…','faturado', 1000, date_trunc('month', now())::date),
 *
 * Conserto: tirar o seed do relógio da sessão — relógio CONTROLADO (`test.agora`) com data LITERAL
 * no seed, ou o fuso NA EXPRESSÃO (`now() AT TIME ZONE 'America/Sao_Paulo'`, ou a forma de 3
 * argumentos do PG14+). Fixar o fuso da SESSÃO (`SET TIME ZONE`, `ALTER DATABASE … TimeZone`) não
 * conta: só alcança as sessões que ele alcança, fixar em UTC mantém a janela, e o fiscal é textual —
 * não vê a sessão.
 *
 * ## A assinatura: a chamada é LIDA, não casada por padrão
 *
 * Todo `date_trunc(` é lido como o Postgres o lê: os argumentos saem com parênteses balanceados e
 * literal opaco, e o comentário de SQL dentro da chamada vira espaço. Reprova quando a unidade é de
 * CALENDÁRIO (literal `day` ou maior, com ou sem cast) e o 2º argumento parte:
 *   · do relógio LOCAL da sessão — `current_date`, `localtimestamp`, `now()::date`/`::timestamp` —,
 *     com ou sem fuso: `AT TIME ZONE` sobre um `timestamp` devolve um `timestamptz`, que a truncagem
 *     de 2 argumentos leva de volta à sessão, e o 3º argumento trunca no fuso certo um instante que
 *     já nasceu na data da sessão. Não tem conserto no lugar: parta de `now() AT TIME ZONE …`;
 *   · do relógio `timestamptz` da sessão — `now()` (também `pg_catalog.now()`, a forma das provas de
 *     relógio controlado), `current_timestamp[(p)]`, `transaction_/statement_/clock_timestamp()` — sem
 *     o fuso escrito: nem `AT TIME ZONE`/`timezone(…)` na expressão, nem o 3º argumento.
 * Por isso casa nu, entre parênteses de qualquer profundidade, com aritmética, com cast, dentro de
 * `coalesce`, em qualquer caixa e quebrado em linhas — e passa `(now() - interval '1 month') AT TIME
 * ZONE …`. O fuso pedido é o EXPLÍCITO, não o de SP: a prova de uma função que mede em UTC de
 * propósito escreve `now() AT TIME ZONE 'UTC'` e passa, com a intenção escrita. O fuso aplicado DEPOIS
 * da truncagem (`date_trunc('month', now()) AT TIME ZONE …`) fica fora da chamada e não conserta nada.
 *
 * Fora, medido em 2026-09-27: `'hour'` e menores (SP tem offset de hora cheia: truncar a hora dá o
 * mesmo instante nos dois fusos); `current_date`/`now()::date` NUS, fora de `date_trunc` (363
 * ocorrências em ~52 provas, quase todas com seed e esperado no MESMO fuso); `to_char`/`extract`/
 * `date_part` sobre o relógio (0 casos da classe em `db/`: os 9 que existem são `epoch`, que é duração,
 * ou já têm fuso); o instante DADO por expressão (`current_setting('test.agora')::timestamptz`, um
 * `p_now`); e a unidade ou o relógio vindos de variável do shell (`date_trunc('$U', now())`).
 *
 * ## A camada do stripper — a decisão de desenho
 *
 * Duas camadas, cada uma só onde mede:
 *   · o ARQUIVO é shell: `removerComentariosShell` limpa `#` e preserva aspas e heredoc — é ele que
 *     decide o que é código;
 *   · a CHAMADA é SQL: `removerComentariosSql` limpa o `--` e o comentário de bloco só na janela que
 *     começa no `(` do `date_trunc`. No arquivo inteiro seria erro de camada: o `--` de `psql --no-psqlrc -c "…"`
 *     apagaria o resto da linha, e a violação junto (verde por cegueira —
 *     docs/historico/gates-textuais-cegos.md).
 * O que sobra fica do lado SEGURO: a forma citada num comentário `--` de SQL, fora de uma chamada, é
 * lida como chamada e reprova (medido: 0 casos em `db/`). Quem precisar citar a forma antiga, cita num
 * `#` do shell. E a chamada que não fecha dentro da janela vira INDETERMINADO, não "limpo".
 *
 * ## O universo e os pisos
 *
 * O MESMO do irmão `relogio-bash-em-provas-gate.ts` — todo shell de `db/`: as provas, `db/lib/` e os
 * falsificadores. As raízes e os pisos vêm de lá, importados: um universo, uma calibração. O walker e
 * os quatro alarmes do stripper vêm de `shell-variavel-colada-gate.ts`, como no irmão. Os `.sql` de
 * `db/` ficam de fora: são corpo de função (`aplicar-*.sql`), stub, fixture ou validação, e hoje têm
 * 0 casamentos.
 */

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { diagnosticarShell, removerComentariosShell } from '@/lib/gates/limpeza-shell';
import { removerComentariosSql } from './lib/sql-comentarios';
import { PISOS, RAIZES_PADRAO } from './relogio-bash-em-provas-gate';
import { alarmesDoStripper, enumerar } from './shell-variavel-colada-gate';

/** `import.meta.dir` é do Bun e não existe sob o vitest — por isso preguiçosa, como nos irmãos. */
const raizDoRepo = () => resolve(import.meta.dir, '..');

/**
 * Onde a chamada começa. Daí em diante ela é LIDA (`lerArgumentos`), não casada por padrão. Exportados
 * (com `JANELA` e `classificar`) para o irmão `fuso-da-sessao-em-migrations-e-skills-gate.ts`: um
 * parser e uma assinatura para os três universos da classe.
 */
export const CHAMADA = /\bdate_trunc\s*\(/gi;

/** Até onde a leitura de UMA chamada vai. A que não fecha antes disso vira INDETERMINADO. */
export const JANELA = 2000;

/** Unidade de CALENDÁRIO, literal, com ou sem cast: truncar a hora dá o mesmo instante em SP e em UTC. */
const UNIDADE = /^'(?:day|week|month|quarter|year|decade|century|millennium)'(?:\s*::\s*[a-z]+)?$/i;

/** O relógio `timestamptz` da sessão: aqui `AT TIME ZONE` ou o 3º argumento fixam o fuso da truncagem. */
const RELOGIO = /\b(?:now\s*\(\s*\)|current_timestamp\b(?:\s*\(\s*\d*\s*\))?|(?:transaction|statement|clock)_timestamp\s*\(\s*\))/i;

/** O relógio LOCAL da sessão — a data/hora de parede DELA. Nenhum fuso escrito depois o conserta. */
const RELOGIO_LOCAL = /\b(?:current_date|localtimestamp)\b/i;

/** O relógio `timestamptz` levado para data/hora LOCAL da sessão: `now()::date`, `now()::timestamp`. */
const CAST_LOCAL = /\b(?:now\s*\(\s*\)|current_timestamp(?:\s*\(\s*\d*\s*\))?|(?:transaction|statement|clock)_timestamp\s*\(\s*\))\s*::\s*(?:date|timestamp)\b(?!\s*with\s+time\s+zone)/i;

/** O fuso escrito na expressão: `AT TIME ZONE …`, ou a forma de função `timezone('…', …)`. */
const FUSO = /\bat\s+time\s+zone\b|\btimezone\s*\(/i;

const PROVA = /^db\/test-[^/]*\.sh$/;

export type Motivo = 'relógio LOCAL da sessão' | 'relógio da sessão sem fuso';

export interface Sitio {
  arquivo: string;
  linha: number;
  trecho: string;
  motivo: Motivo;
}

export interface Analise {
  caminhos: string[];
  linhasDeCodigo: number;
  violacoes: Sitio[];
  alarmes: string[];
  /** Chamadas de `date_trunc(` que não fecham dentro da janela: o fiscal não as leu. */
  ilegiveis: string[];
}

/** Índice da aspa que fecha a que abre em `ini` (a aspa dobrada é escape), ou -1. */
function fimDasAspas(sql: string, ini: number): number {
  for (let j = ini + 1; j < sql.length; j++) {
    if (sql[j] !== sql[ini]) continue;
    if (sql[j + 1] === sql[ini]) j++;
    else return j;
  }
  return -1;
}

/**
 * Os argumentos de nível 1 da chamada cujo `(` abre o texto, lidos como o Postgres lê: `'…'` e `"…"`
 * são opacos (a vírgula e o parêntese de dentro não contam). null = a chamada não fecha no texto.
 */
export function lerArgumentos(sql: string): string[] | null {
  const args: string[] = [];
  let profundidade = 0;
  let inicio = 1;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      i = fimDasAspas(sql, i);
      if (i === -1) return null;
    } else if (c === '(') {
      profundidade++;
    } else if (c === ')') {
      profundidade--;
      if (profundidade === 0) {
        args.push(sql.slice(inicio, i).trim());
        return args;
      }
    } else if (c === ',' && profundidade === 1) {
      args.push(sql.slice(inicio, i).trim());
      inicio = i + 1;
    }
  }
  return null;
}

export function classificar([unidade, expressao, fuso]: string[]): Motivo | null {
  if (!UNIDADE.test(unidade ?? '') || !expressao) return null;
  if (RELOGIO_LOCAL.test(expressao) || CAST_LOCAL.test(expressao)) return 'relógio LOCAL da sessão';
  if (!RELOGIO.test(expressao)) return null;
  if (fuso !== undefined || FUSO.test(expressao)) return null;
  return 'relógio da sessão sem fuso';
}

export function detectar(caminho: string, fonte: string): { sitios: Sitio[]; linhasDeCodigo: number; ilegiveis: string[] } {
  // A limpeza do SHELL preserva o número de linhas (não as colunas): a linha contada no limpo é a da FONTE.
  const limpo = removerComentariosShell(fonte);
  const linhas = limpo.split('\n');
  const linhasDeCodigo = linhas.filter((l) => l.trim() !== '').length;
  const sitios: Sitio[] = [];
  const ilegiveis: string[] = [];
  for (const m of limpo.matchAll(CHAMADA)) {
    const i = limpo.slice(0, m.index).split('\n').length - 1;
    const abre = m.index + m[0].length - 1;
    // A camada de SQL só DENTRO da chamada: ali `--` é comentário; no shell em volta, é flag.
    const args = lerArgumentos(removerComentariosSql(limpo.slice(abre, abre + JANELA)));
    if (args === null) {
      ilegiveis.push(`${caminho}:${i + 1}: date_trunc( que não fecha em ${JANELA} caracteres — a chamada não foi lida`);
      continue;
    }
    const motivo = classificar(args);
    if (motivo) sitios.push({ arquivo: caminho, linha: i + 1, trecho: linhas[i].trim(), motivo });
  }
  return { sitios, linhasDeCodigo, ilegiveis };
}

export function analisar(arquivos: { caminho: string; fonte: string }[]): Analise {
  const r: Analise = { caminhos: [], linhasDeCodigo: 0, violacoes: [], alarmes: [], ilegiveis: [] };
  for (const a of arquivos) {
    const d = detectar(a.caminho, a.fonte);
    r.caminhos.push(a.caminho);
    r.linhasDeCodigo += d.linhasDeCodigo;
    r.violacoes.push(...d.sitios);
    r.ilegiveis.push(...d.ilegiveis);
    r.alarmes.push(...alarmesDoStripper(a.caminho, diagnosticarShell(a.fonte)));
  }
  return r;
}

export function veredito(r: Analise, comPisos: boolean): { codigo: 0 | 1 | 2; linhas: string[] } {
  const furos = [...r.alarmes.map((a) => `stripper desabando — ${a}`), ...r.ilegiveis.map((x) => `chamada ilegível — ${x}`)];
  if (r.caminhos.length === 0) furos.push('nenhum arquivo shell lido');
  const provas = r.caminhos.filter((c) => PROVA.test(c)).length;
  if (comPisos) {
    if (provas < PISOS.provas) furos.push(`${provas} prova(s) db/test-*.sh lida(s) < piso ${PISOS.provas}`);
    if (r.linhasDeCodigo < PISOS.linhasDeCodigo) {
      furos.push(`${r.linhasDeCodigo} linhas de código lidas < piso ${PISOS.linhasDeCodigo} — abriu arquivo, mas não leu código?`);
    }
  }
  if (furos.length > 0) {
    return {
      codigo: 2,
      linhas: ['❌ INDETERMINADO — o fiscal não conseguiu medir (isto NÃO é "limpo"):', ...furos.map((f) => `  · ${f}`)],
    };
  }
  if (r.violacoes.length > 0) {
    return {
      codigo: 1,
      linhas: [
        `❌ ${r.violacoes.length} date_trunc de calendário sobre o relógio da SESSÃO em shell de db/:`,
        ...r.violacoes.map((s) => `  ${s.arquivo}:${s.linha} (${s.motivo})\n      ${s.trecho.slice(0, 140)}`),
        '',
        '  O fuso da sessão é UTC no CI e SP no Mac. Contra uma função que calcula em America/Sao_Paulo, das',
        '  21:00 às 23:59 BRT o seed cai no dia seguinte (no último dia do mês, no mês seguinte) e a prova',
        '  reprova sozinha, numa janela que o CI só sorteia às vezes.',
        '  Conserto: relógio CONTROLADO (`test.agora`) com data LITERAL no seed, ou o fuso NA EXPRESSÃO —',
        "  `date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')`, ou a forma de 3 argumentos.",
        '  O relógio LOCAL da sessão (current_date, localtimestamp, now()::date) não tem conserto no lugar:',
        "  nem AT TIME ZONE nem o 3º argumento o salvam — parta de now() AT TIME ZONE 'America/Sao_Paulo'.",
        '  Fixar o fuso da sessão (SET TIME ZONE, ALTER DATABASE … TimeZone) não conta: o fiscal não vê a',
        '  sessão. Citar a forma antiga num comentário `--` de SQL reprova: cite num `#` do shell.',
        '  docs/historico/provas-janela-de-relogio-fora-do-nucleo.md',
      ],
    };
  }
  const censo = comPisos ? ` (${provas} provas)` : '';
  return {
    codigo: 0,
    linhas: [
      `✅ fuso da sessão em provas: ${r.caminhos.length} arquivo(s) shell${censo}, ${r.linhasDeCodigo} linhas de código ` +
        'lidas. Nenhum date_trunc de calendário sobre o relógio da sessão sem fuso.',
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
