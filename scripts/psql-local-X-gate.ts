#!/usr/bin/env bun
/**
 * psql-local-X-gate.ts — fiscal TEXTUAL: toda chamada de psql LOCAL em shell leva `-X` logo depois
 * do binário. Não executa shell nenhum.
 *
 *   bun scripts/psql-local-X-gate.ts              # corpo do repo (com PISOS)
 *   bun scripts/psql-local-X-gate.ts <dir…>       # corpo arbitrário (sem piso — é fixture)
 *
 * exit 0 = limpo · 1 = violação · 2 = o fiscal não conseguiu medir (nenhum arquivo lido, piso de
 * denominador furado, stripper desabando). 2 NUNCA é "passou". Roda no CI pelo vitest
 * (`psql-local-X-gate.test.ts`); as mutações que provam o dente de cada camada estão em
 * `scripts/mutcheck.d/psql-local-X.mut`.
 *
 * ## A classe (docs/historico/psql-sem-X-le-o-psqlrc.md)
 *
 * O psql lê `~/.psqlrc` (ou o arquivo de `$PSQLRC`) DEPOIS das opções de linha de comando. Um
 * `\set ON_ERROR_STOP off` pessoal anula o `-v ON_ERROR_STOP=1` do helper `P()`: o script lido de
 * `-f`/stdin segue depois do erro e sai 0 — o `set -e` não dispara, e a prova aprova a migration que
 * em prod ABORTA (medido: `test-sales_orders_omie_hash_unique` com um statement que erra sai
 * `5 ok / 0 fail`, exit 0). `\x`/`\pset`/`\timing` mudam a saída que os asserts comparam. O CI não
 * tem psqlrc nenhum, então a execução nunca veria: só pelo texto.
 *
 * ## O que é "psql local"
 *
 * Um token cujo caminho termina em `/psql` — entre aspas (`"$PGBIN/psql"`), nu (`$PGBIN/psql`,
 * `${PGBIN}/psql`, `/usr/lib/postgresql/17/bin/psql`) ou com a aspa antes da barra
 * (`"$PGBIN"/psql`). Atribuição a variável conta (`PSQL=("$PGBIN/psql" -X …)` é a forma certa de
 * guardar o binário): quem invoca a variável depois herda o `-X` dali. NÃO é psql local: o wrapper
 * `psql-ro` — o `psqlrc-ro` dele É a trava de SESSION READ ONLY + `statement_timeout`, e um `-X` ali
 * a desligaria. Depois de `psql` tem de vir fronteira: `psql-ro`, `psqlrc` e `psql_x` não casam.
 *
 * ## A única isenção: `PSQLRC=` explícito no MESMO comando
 *
 * `exec env PSQLRC="$TMPD/psqlrc-fake" "$PGBIN/psql" …` — o fake que imita o wrapper de prod LÊ um
 * psqlrc de propósito (é o objeto do teste). Quem nomeia o arquivo escolheu o que o psql lê; o que
 * esta regra proíbe é o psqlrc que ninguém escolheu. O comentário é isenção também, e quem a decide
 * é o stripper COMPARTILHADO (docs/historico/gates-textuais-cegos.md): `#` dentro de aspas é dado.
 * Aspas e heredoc NÃO isentam — o fake escrito por `cat > fake <<EOF` roda depois.
 */

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { diagnosticarShell, removerComentariosShell } from '@/lib/gates/limpeza-shell';
import { PISOS as PISOS_DO_IRMAO, RAIZES_PADRAO, alarmesDoStripper, enumerar } from './shell-variavel-colada-gate';

/** `import.meta.dir` é do Bun e não existe sob o vitest — por isso preguiçosa, como nos irmãos. */
const raizDoRepo = () => resolve(import.meta.dir, '..');

export { RAIZES_PADRAO };

/**
 * PISOS — o denominador do fiscal, medido em 2026-09-30 depois da erradicação. Sem eles, "0
 * violações" com o detector cego é indistinguível de "0 violações" por mérito. Piso é alarme de
 * fumaça: folgado abaixo do medido, SOBE quando o repo cresce, nunca desce para caber.
 */
export const PISOS = {
  /** Os arquivos por raiz são os do irmão: o universo é o MESMO walker, a calibração é uma só. */
  arquivosPorRaiz: PISOS_DO_IRMAO.arquivosPorRaiz,
  /**
   * Chamadas de psql local JÁ com `-X`, só em `db/`: a forma certa vista. Se a leitura do binário
   * cegar (regex quebrada, stripper comendo o código), as violações zeram junto — e só este piso diz
   * que o zero não foi mérito. Por raiz porque `db/` é onde mora a classe (as provas PG17).
   */
  comXEmDb: 350, // medido: 416
} as const;

/**
 * O binário: token que termina em `/psql` seguido de fronteira. Três formas, na ordem em que o motor
 * tenta: entre aspas duplas, entre aspas simples, e nu (que também cobre `"$PGBIN"/psql`, onde a aspa
 * fecha antes da barra). A fronteira é o que separa `psql` de `psql-ro`/`psqlrc`/`psql_x`.
 */
const BINARIO = /(?:"[^"\n]*\/psql"|'[^'\n]*\/psql'|[^\s"'`;|&()<>]*\/psql)(?=[\s;|&)`]|$)/g;
/** A forma certa: `-X` como palavra própria, logo depois do binário (mesma linha). */
const COM_X = /^[ \t]+-X(?=[\s;|&)`]|$)/;
/** Onde começa o COMANDO que contém o binário: depois do último separador da linha. */
const SEPARADOR = /[;|&({`]/g;
const PSQLRC_EXPLICITO = /(?:^|\s)PSQLRC=/;

export type Situacao = 'comX' | 'isentoPsqlrc' | 'violacao';

export interface Sitio {
  arquivo: string;
  linha: number;
  situacao: Situacao;
  binario: string;
  trecho: string;
}

export interface Analise {
  caminhos: string[];
  sitios: Sitio[];
  alarmes: string[];
}

/** O trecho do MESMO comando antes do binário — do último separador até ele. */
function comandoAte(linha: string, ini: number): string {
  const antes = linha.slice(0, ini);
  let corte = 0;
  for (const m of antes.matchAll(SEPARADOR)) corte = m.index + 1;
  return antes.slice(corte);
}

export function detectar(caminho: string, fonte: string): Sitio[] {
  const sitios: Sitio[] = [];
  // A limpeza preserva o número de linhas: o índice aqui é a linha da FONTE.
  removerComentariosShell(fonte)
    .split('\n')
    .forEach((linha, i) => {
      for (const m of linha.matchAll(BINARIO)) {
        const depois = linha.slice(m.index + m[0].length);
        const situacao: Situacao = COM_X.test(depois)
          ? 'comX'
          : PSQLRC_EXPLICITO.test(comandoAte(linha, m.index))
            ? 'isentoPsqlrc'
            : 'violacao';
        sitios.push({ arquivo: caminho, linha: i + 1, situacao, binario: m[0], trecho: linha.trim() });
      }
    });
  return sitios;
}

export function analisar(arquivos: { caminho: string; fonte: string }[]): Analise {
  const r: Analise = { caminhos: [], sitios: [], alarmes: [] };
  for (const a of arquivos) {
    r.caminhos.push(a.caminho);
    r.sitios.push(...detectar(a.caminho, a.fonte));
    r.alarmes.push(...alarmesDoStripper(a.caminho, diagnosticarShell(a.fonte)));
  }
  return r;
}

const contar = (r: Analise, s: Situacao, raiz?: string) =>
  r.sitios.filter((x) => x.situacao === s && (raiz === undefined || x.arquivo.startsWith(`${raiz}/`))).length;

export function veredito(r: Analise, comPisos: boolean): { codigo: 0 | 1 | 2; linhas: string[] } {
  const furos = r.alarmes.map((a) => `stripper desabando — ${a}`);
  if (r.caminhos.length === 0) furos.push('nenhum arquivo shell lido');
  const comXEmDb = contar(r, 'comX', 'db');
  if (comPisos) {
    for (const [raiz, piso] of Object.entries(PISOS.arquivosPorRaiz)) {
      const lidos = r.caminhos.filter((c) => c.startsWith(`${raiz}/`)).length;
      if (lidos < piso) furos.push(`${lidos} arquivo(s) shell em ${raiz}/ < piso ${piso}`);
    }
    if (comXEmDb < PISOS.comXEmDb) {
      furos.push(`${comXEmDb} chamada(s) de psql local com -X vistas em db/ < piso ${PISOS.comXEmDb} — o detector cegou?`);
    }
  }
  if (furos.length > 0) {
    return {
      codigo: 2,
      linhas: ['❌ INDETERMINADO — o fiscal não conseguiu medir (isto NÃO é "limpo"):', ...furos.map((f) => `  · ${f}`)],
    };
  }
  const violacoes = r.sitios.filter((s) => s.situacao === 'violacao');
  if (violacoes.length > 0) {
    return {
      codigo: 1,
      linhas: [
        `❌ ${violacoes.length} chamada(s) de psql local SEM -X logo depois do binário:`,
        ...violacoes.map((s) => `  ${s.arquivo}:${s.linha}  ${s.binario}\n      ${s.trecho.slice(0, 140)}`),
        '',
        '  O psql lê ~/.psqlrc (ou $PSQLRC) DEPOIS das opções: um `\\set ON_ERROR_STOP off` pessoal anula o',
        '  `-v ON_ERROR_STOP=1` e a prova aprova o SQL que errou. Conserto: `"$PGBIN/psql" -X …`. Fake que',
        '  lê um psqlrc DE PROPÓSITO nomeia o arquivo no mesmo comando (`env PSQLRC=<arq> "$PGBIN/psql" …`).',
        '  NUNCA ponha -X no psql-ro: o psqlrc-ro dele é a trava de READ ONLY. docs/historico/psql-sem-X-le-o-psqlrc.md',
      ],
    };
  }
  return {
    codigo: 0,
    linhas: [
      `✅ psql local com -X: ${r.caminhos.length} arquivo(s) shell, ${contar(r, 'comX')} chamada(s) com -X ` +
        `(${comXEmDb} em db/) e ${contar(r, 'isentoPsqlrc')} com PSQLRC= explícito. Nenhuma sem -X.`,
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
