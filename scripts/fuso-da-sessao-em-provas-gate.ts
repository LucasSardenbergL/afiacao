#!/usr/bin/env bun
/**
 * fuso-da-sessao-em-provas-gate.ts — fiscal TEXTUAL da prova SQL que semeia (ou calcula o esperado)
 * truncando o relógio no fuso da SESSÃO. Não executa shell nem SQL nenhum.
 *
 *   bun scripts/fuso-da-sessao-em-provas-gate.ts              # todo shell de db/ (com PISOS)
 *   bun scripts/fuso-da-sessao-em-provas-gate.ts <dir…>       # corpo arbitrário (sem piso — é fixture)
 *
 * exit 0 = limpo · 1 = violação · 2 = o fiscal não conseguiu medir (nenhum arquivo lido, piso de
 * denominador furado, stripper desabando). 2 NUNCA é "passou". Roda no CI pelo vitest
 * (`fuso-da-sessao-em-provas-gate.test.ts`); as mutações que provam o dente de cada camada estão em
 * `scripts/mutcheck.d/fuso-da-sessao-em-provas.mut`.
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
 * ## A assinatura, e o que fica de fora de propósito
 *
 * `date_trunc` com unidade de CALENDÁRIO (`day` ou maior) sobre o relógio da sessão SEM fuso: `now()`
 * (também qualificado, `pg_catalog.now()`, a forma das provas de relógio controlado),
 * `current_timestamp`, `current_date`, `localtimestamp` e `transaction_/statement_/clock_timestamp()`.
 * Casa nu, entre parênteses, com aritmética (`now() - interval '1 month'`) ou com cast (`now()::date`):
 * quem decide é o que vem DEPOIS do relógio. `AT TIME ZONE` e a vírgula do 3º argumento fixam o fuso
 * e não casam. SQL não liga para caixa, e o fiscal também não.
 *
 * Fora, medido em 2026-09-27: `'hour'` e menores (SP tem offset de hora cheia: truncar a hora dá o
 * mesmo instante nos dois fusos); `current_date`/`now()::date` NUS (363 ocorrências em ~52 provas,
 * quase todas com seed e esperado no MESMO fuso); `to_char`/`extract`/`date_part` sobre o relógio (0
 * casos da classe em `db/`: os 9 que existem são `epoch`, que é duração, ou já têm fuso); e o
 * instante DADO por expressão (`current_setting('test.agora')::timestamptz`, um `p_now`).
 *
 * ## A camada do stripper — a decisão de desenho
 *
 * A assinatura mora em SQL dentro de shell (heredoc, `-c "…"`), onde comentário é `--`. Mesmo assim
 * a limpeza é a do SHELL (`removerComentariosShell`), e só ela:
 *   · `removerComentariosSql` no arquivo inteiro é erro de CAMADA: o `--` de `psql --no-psqlrc -c
 *     "…"` apagaria o resto da linha, e a violação junto (verde por cegueira —
 *     docs/historico/gates-textuais-cegos.md);
 *   · aplicá-lo só ao corpo de heredoc pediria separar o heredoc de SQL do heredoc que GERA script
 *     (`cat > fake.sh <<EOF`) — e o erro dessa triagem cai do lado perigoso, o mesmo `--flag`;
 *   · o preço desta escolha cai do lado SEGURO: a forma citada num comentário `--` de SQL reprova
 *     (vermelho num comentário, nunca verde num código). Medido: 0 casos em `db/`. Quem precisar
 *     citar a forma antiga, cita num `#` do shell, que o stripper limpa.
 * `#` dentro de aspas e de heredoc é dado — e a regex local, que não sabe disso, é proibida na casa.
 *
 * ## O universo e os pisos
 *
 * O MESMO do irmão `relogio-bash-em-provas-gate.ts` — todo shell de `db/`: as provas, `db/lib/` e os
 * falsificadores. As raízes e os pisos vêm de lá, importados: um universo, uma calibração. O walker e
 * os quatro alarmes do stripper vêm de `shell-variavel-colada-gate.ts`, como no irmão. Os `.sql` de
 * `db/` ficam de fora: são corpo de função (`aplicar-*.sql`), stub, fixture ou validação, a camada
 * deles seria outra (`removerComentariosSql`), e hoje têm 0 casamentos.
 */

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { diagnosticarShell, removerComentariosShell } from '@/lib/gates/limpeza-shell';
import { PISOS, RAIZES_PADRAO } from './relogio-bash-em-provas-gate';
import { alarmesDoStripper, enumerar } from './shell-variavel-colada-gate';

/** `import.meta.dir` é do Bun e não existe sob o vitest — por isso preguiçosa, como nos irmãos. */
const raizDoRepo = () => resolve(import.meta.dir, '..');

/** Unidade de CALENDÁRIO: truncar a hora (ou menos) dá o mesmo instante em SP e em UTC. */
const UNIDADE = String.raw`'(?:day|week|month|quarter|year|decade|century|millennium)'`;

/** `(now())`: entre parênteses, o relógio segue sendo o da sessão. */
const PARENTESE = String.raw`\(?\s*`;

/** `pg_catalog.now()`: qualificado — a forma das provas de relógio controlado. */
const QUALIFICADOR = String.raw`(?:[a-z_][a-z0-9_]*\s*\.\s*)?`;

/** O relógio da SESSÃO. Cada forma numa linha: é o que deixa o `.mut` tirar uma por vez. */
const RELOGIO = [
  String.raw`now\s*\(\s*\)`,
  String.raw`current_timestamp(?:\s*\(\s*\d*\s*\))?`,
  String.raw`current_date`,
  String.raw`localtimestamp(?:\s*\(\s*\d*\s*\))?`,
  String.raw`(?:transaction|statement|clock)_timestamp\s*\(\s*\)`,
].join('|');

/**
 * Depois do relógio, só o que MANTÉM o fuso da sessão: `)` (nu), `+`/`-` (aritmética) ou `::` (cast).
 * `AT TIME ZONE` e a vírgula do 3º argumento ficam de fora — é onde o fuso vira explícito.
 */
const DEPOIS_DO_RELOGIO = String.raw`(?:\)|[-+]|::)`;

/** Sobre o texto INTEIRO, não linha a linha: SQL quebra linha no meio da chamada. */
const ASSINATURA = new RegExp(
  String.raw`\bdate_trunc\s*\(\s*${UNIDADE}\s*,\s*${PARENTESE}${QUALIFICADOR}(?:${RELOGIO})\s*${DEPOIS_DO_RELOGIO}`,
  'gi',
);
const PROVA = /^db\/test-[^/]*\.sh$/;

export interface Sitio {
  arquivo: string;
  linha: number;
  trecho: string;
}

export interface Analise {
  caminhos: string[];
  linhasDeCodigo: number;
  violacoes: Sitio[];
  alarmes: string[];
}

export function detectar(caminho: string, fonte: string): { sitios: Sitio[]; linhasDeCodigo: number } {
  // A limpeza preserva o número de linhas (não as colunas): a linha contada no limpo é a da FONTE.
  const limpo = removerComentariosShell(fonte);
  const linhas = limpo.split('\n');
  const linhasDeCodigo = linhas.filter((l) => l.trim() !== '').length;
  const sitios: Sitio[] = [];
  for (const m of limpo.matchAll(ASSINATURA)) {
    const i = limpo.slice(0, m.index).split('\n').length - 1;
    sitios.push({ arquivo: caminho, linha: i + 1, trecho: linhas[i].trim() });
  }
  return { sitios, linhasDeCodigo };
}

export function analisar(arquivos: { caminho: string; fonte: string }[]): Analise {
  const r: Analise = { caminhos: [], linhasDeCodigo: 0, violacoes: [], alarmes: [] };
  for (const a of arquivos) {
    const d = detectar(a.caminho, a.fonte);
    r.caminhos.push(a.caminho);
    r.linhasDeCodigo += d.linhasDeCodigo;
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
        `❌ ${r.violacoes.length} date_trunc de calendário sobre o relógio da SESSÃO, sem fuso, em shell de db/:`,
        ...r.violacoes.map((s) => `  ${s.arquivo}:${s.linha}\n      ${s.trecho.slice(0, 140)}`),
        '',
        '  O fuso da sessão é UTC no CI e SP no Mac. Contra uma função que calcula em America/Sao_Paulo, das',
        '  21:00 às 23:59 BRT o seed cai no dia seguinte (no último dia do mês, no mês seguinte) e a prova',
        '  reprova sozinha, numa janela que o CI só sorteia às vezes.',
        '  Conserto: relógio CONTROLADO (`test.agora`) com data LITERAL no seed, ou o fuso NA EXPRESSÃO —',
        "  `date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')`, ou a forma de 3 argumentos.",
        '  Fixar o fuso da sessão (SET TIME ZONE, ALTER DATABASE … TimeZone) não conta: o fiscal não vê a',
        '  sessão. Um comentário `--` de SQL conta como código aqui: cite a forma antiga num `#` do shell.',
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
