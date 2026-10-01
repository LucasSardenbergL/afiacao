/**
 * psql-ro-error-stop.ts — o fiscal de que TODA leitura do wrapper `psql-ro` por `-f`/stdin/heredoc
 * carrega `-v ON_ERROR_STOP=1`.
 *
 * A CLASSE (medida 2026-09-05, docs/historico/psql-ro-exit-zero-em-sql-que-falhou.md): o wrapper
 * `~/.config/afiacao/psql-ro` não passa `ON_ERROR_STOP`, e o psql só devolve rc≠0 por conta
 * própria na forma `-c`. Lido de `-f`, de `<` ou de heredoc ele sai **0 mesmo com ERROR** — a
 * query não roda, o ERROR vai para o corpo, e o script recebe SUCESSO. No `db/audit-anon-dml-
 * bypass.sh` isso imprimia "✅ LIMPO" num linter de bypass de RLS: falha ABERTA, família
 * "ausente ≠ zero".
 *
 * Hoje 13 dos 14 consumidores estão protegidos **por acidente da forma** (`-c`), não por regra.
 * Este módulo é a regra.
 *
 * POR QUE O ALVO É A VARIÁVEL, não a string `psql-ro`: o repo tem 200+ menções a `psql-ro`, quase
 * todas em comentário e em prosa de cabeçalho. Casar a string daria um gate que grita em prosa e
 * cala em código. O que executa é uma VARIÁVEL — e ela não tem nome fixo (`$PSQL`, `$PSQL_RO`,
 * `$PSQLRO`, `$AFIACAO_PSQL`, `$WRAP`…), então o vínculo é DESCOBERTO no próprio arquivo. Lista
 * fixa de nomes fecharia a porta de hoje e deixaria aberta a do próximo script.
 *
 * NÃO CONFUNDIR com o psql LOCAL de PG17 dos harnesses (`"$PGBIN/psql"`): é outro binário, já
 * passa `ON_ERROR_STOP=1`, e nenhum vínculo dele aponta para `psql-ro`. A discriminação é provada
 * como caso POSITIVO no dente, não deixada por sorte.
 *
 * DOIS EIXOS (o segundo desde 2026-10-01): quem EXECUTA o wrapper (shell, `execFileSync`) e quem
 * IMPRIME o comando para o operador rodar — o literal TS de um gerador. Ver "instrução EMITIDA".
 */

import { createRequire } from 'node:module';

import type * as TS from 'typescript';

import { removerComentarios } from '@/lib/gates/limpeza-fonte';
import { fatiarPalavras, mascaraContexto, removerComentariosShell } from '@/lib/gates/limpeza-shell';

/** Nomes SEMENTE: usados sem `=` no arquivo, herdados do ambiente. Um `=` local que aponte para
 *  outra coisa REFUTA a semente naquele arquivo (é assim que `PSQL="$PGBIN/psql"` não vira alvo). */
const NOMES_SEMENTE = ['PSQL', 'PSQL_RO', 'PSQLRO', 'AFIACAO_PSQL'] as const;

/** Marca do wrapper num RHS. `psql-ro-fake` casa de propósito: o fake IMITA prod (sem
 *  ON_ERROR_STOP), então lê-lo por `-f` tem exatamente o mesmo defeito. */
const MARCA_WRAPPER = /psql-ro/;

export interface Sitio {
  arquivo: string;
  linha: number;
  /** `execucao`: o arquivo RODA o wrapper. `emissao`: o arquivo IMPRIME o comando que alguém roda. */
  origem: 'execucao' | 'emissao';
  /** A variável que aponta para o wrapper; na emissão, o caminho como foi impresso. */
  variavel: string;
  /** O comando inteiro, das aspas da variável até o terminador — é o que foi classificado. */
  trecho: string;
  temC: boolean;
  temF: boolean;
  temStdin: boolean;
  temErrorStop: boolean;
  precisaErrorStop: boolean;
  viola: boolean;
}

/** O fiscal não conseguiu medir o arquivo — e isso nunca é "limpo". */
export interface Indeterminado {
  arquivo: string;
  motivo: string;
}

export interface Resultado {
  /** Quem EXECUTA o wrapper — o censo do #2167. */
  sitios: Sitio[];
  /** Quem IMPRIME o comando para o operador — o eixo de 2026-10-01. */
  emitidos: Sitio[];
  violacoes: Sitio[];
  indeterminados: Indeterminado[];
  arquivosLidos: number;
  arquivosComVinculo: number;
}

// ─────────────────────────────── classificação de argumentos ───────────────────────────────

/** Um cluster de opções curtas do psql (`-Atc`) contém a letra `l`? `--` não é cluster. */
function clusterContem(prefixoNu: string, letra: string): boolean {
  if (!/^-[A-Za-z0-9]+$/.test(prefixoNu)) return false;
  return prefixoNu.slice(1).includes(letra);
}

/** `ON_ERROR_STOP` LIGADO. O nome é maiúsculo fixo de propósito: variável de psql é
 *  case-sensitive (`on_error_stop` não funciona), e casar em caixa fixa ASCII torna o fiscal
 *  imune a locale — a armadilha do `grep '^ERROR'` que o pt_BR traduz. */
function ligaErrorStop(valor: string): boolean {
  const v = valor.trim().replace(/^['"]|['"]$/g, '');
  if (!v.startsWith('ON_ERROR_STOP')) return false;
  const igual = v.indexOf('=');
  if (igual === -1) return false;
  const alvo = v.slice(0, igual);
  if (alvo !== 'ON_ERROR_STOP') return false;
  const bruto = v.slice(igual + 1).replace(/^['"]|['"]$/g, '').toLowerCase();
  // psql: qualquer valor liga, EXCETO os desligados explícitos. Vazio (`-v ON_ERROR_STOP=`) liga.
  return !['off', '0', 'false', 'no'].includes(bruto);
}

interface Classificacao {
  temC: boolean;
  temF: boolean;
  temErrorStop: boolean;
}

/**
 * A lista de argumentos é montada em outro lugar (`"$@"` de função-wrapper, `"${ARGS[@]}"`)?
 * Um gate textual não consegue ver de onde vem o SQL nesse caso — e "não consegui ver" tratado
 * como "não precisa" é o zero-que-vira-veredito de novo. Aqui vira EXIGÊNCIA: quem repassa
 * argumento opaco tem de fixar `-c` ou carregar `ON_ERROR_STOP` de saída.
 */
export function repassaArgumentosOpacos(palavras: { cru: string; prefixoNu: string }[]): boolean {
  return palavras.some((p) => /\$\{?@|\[@\]|\$\*/.test(p.cru));
}

/**
 * Classifica uma lista de palavras de argumento (shell ou literais do array do `execFileSync`).
 */
export function classificarArgumentos(palavras: { cru: string; prefixoNu: string }[]): Classificacao {
  let temC = false;
  let temF = false;
  let temErrorStop = false;

  for (let i = 0; i < palavras.length; i++) {
    const { cru, prefixoNu } = palavras[i];
    const nu = prefixoNu === '' ? cru : prefixoNu;

    if (nu === '--command' || nu.startsWith('--command=')) temC = true;
    if (nu === '--file' || nu.startsWith('--file=')) temF = true;
    if (clusterContem(nu, 'c')) temC = true;
    if (clusterContem(nu, 'f')) temF = true;

    if (nu.startsWith('--set=') || nu.startsWith('--variable=')) {
      if (ligaErrorStop(nu.slice(nu.indexOf('=') + 1))) temErrorStop = true;
    }
    if (nu === '--set' || nu === '--variable') {
      const prox = palavras[i + 1];
      if (prox && ligaErrorStop(prox.prefixoNu === '' ? prox.cru : prox.prefixoNu)) temErrorStop = true;
    }
    // `-v ON_ERROR_STOP=1` (valor separado) e `-vON_ERROR_STOP=1` (colado). Só o `-v` aceita a
    // forma colada: liberá-la para `c`/`f` faria `-vfoo=1` casar como `-f`, e falso positivo em
    // fiscal custa a confiança nele — que é o começo de ser desligado.
    const colado = /^-[A-Za-z0-9]*v(.+)$/.exec(nu);
    if (colado && ligaErrorStop(colado[1])) temErrorStop = true;
    if (clusterContem(nu, 'v')) {
      const prox = palavras[i + 1];
      if (prox && ligaErrorStop(prox.prefixoNu === '' ? prox.cru : prox.prefixoNu)) temErrorStop = true;
    }
  }

  return { temC, temF, temErrorStop };
}

// ─────────────────────────────────────── shell ───────────────────────────────────────

/** Depois de `rstrip`, o último caractere que ainda deixa a variável em POSIÇÃO DE COMANDO. */
const ANTES_DE_COMANDO = new Set(['', '\n', ';', '|', '&', '(', '`', '{', '}', '!']);
const PALAVRA_ANTES_DE_COMANDO = /(?:^|[^\w$-])(then|else|do|exec|command|env|time|eval|nohup)$/;

function emPosicaoDeComando(antes: string): boolean {
  const t = antes.replace(/[ \t]+$/, '');
  if (t === '') return true;
  if (ANTES_DE_COMANDO.has(t[t.length - 1])) return true;
  return PALAVRA_ANTES_DE_COMANDO.test(t);
}

/**
 * Fim do comando a partir de `ini`: o primeiro terminador FORA de aspas. Aspas em shell
 * atravessam newline de propósito (o repo tem `-c "` com SQL de 8 linhas), então o scanner tem de
 * ser ciente de aspas — cortar na primeira quebra de linha perderia metade dos argumentos.
 */
function fimDoComando(s: string, ini: number): number {
  let i = ini;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const f = s.indexOf("'", i + 1); i = f === -1 ? n : f + 1; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '"') break;
        j++;
      }
      i = j >= n ? n : j + 1;
      continue;
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === ')' || c === '`') return i;
    i++;
  }
  return n;
}

/**
 * O SQL chega por CANO? `… | "$PSQL"` lê o stdin do pipe — e é a forma de toda instrução que um
 * gerador imprime (`bun run sonda:sql … | ~/.config/afiacao/psql-ro`). Até 2026-10-01 o fiscal só
 * via `<`/heredoc, e o pipe passava sem ON_ERROR_STOP. `||` é OU lógico, não cano; `|&` (bash) é
 * cano com o stderr junto. A quebra de linha depois do `|` continua o pipeline, então sai junto.
 */
function recebeDoCano(antes: string): boolean {
  const t = antes.replace(/(?:\s|\\\n)+$/, '');
  return /(?:^|[^|])\|&?$/.test(t);
}

/** Há leitura de stdin (`<`, `<<`, `<<<`) FORA de aspas neste trecho? */
function leDeStdin(trecho: string): boolean {
  let i = 0;
  const n = trecho.length;
  while (i < n) {
    const c = trecho[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const f = trecho.indexOf("'", i + 1); i = f === -1 ? n : f + 1; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (trecho[j] === '\\') { j += 2; continue; }
        if (trecho[j] === '"') break;
        j++;
      }
      i = j >= n ? n : j + 1;
      continue;
    }
    if (c === '<') return true;
    i++;
  }
  return false;
}

const NOME_VAR = '[A-Za-z_][A-Za-z0-9_]*';

/**
 * Descobre, no arquivo shell, quais nomes de variável apontam para o wrapper.
 *
 * Três fontes, nesta ordem: (1) atribuição cujo RHS carrega a marca `psql-ro`; (2) ALIAS — RHS que
 * é só a expansão de um nome já vinculado (`WRAP_ATUAL="$WRAP"`), resolvido por ponto-fixo;
 * (3) as sementes de ambiente, válidas só enquanto o arquivo não as REFUTAR com um `=` que aponta
 * para outra coisa (é o que separa `PSQL="$HOME/.config/afiacao/psql-ro"` de `PSQL="$PGBIN/psql"`).
 */
export function descobrirVinculosShell(limpo: string): Set<string> {
  const vinculados = new Set<string>();
  const refutados = new Set<string>();
  const atribuicoes: { nome: string; rhs: string }[] = [];

  const re = new RegExp(`^[ \\t]*(?:export[ \\t]+|local[ \\t]+|declare[ \\t]+(?:-\\w+[ \\t]+)?)?(${NOME_VAR})=(.*)$`, 'gm');
  for (const m of limpo.matchAll(re)) {
    atribuicoes.push({ nome: m[1], rhs: m[2] });
  }

  for (const { nome, rhs } of atribuicoes) {
    if (MARCA_WRAPPER.test(rhs)) vinculados.add(nome);
  }

  // Ponto-fixo dos aliases: `WRAP_ATUAL="$WRAP"`, `P="${PSQL_RO}"`.
  const soExpansao = new RegExp(`^["']?\\$\\{?(${NOME_VAR})[:}\\-]*[^}]*\\}?["']?$`);
  let mudou = true;
  while (mudou) {
    mudou = false;
    for (const { nome, rhs } of atribuicoes) {
      if (vinculados.has(nome)) continue;
      const m = soExpansao.exec(rhs.trim());
      if (m && vinculados.has(m[1])) { vinculados.add(nome); mudou = true; }
    }
  }

  for (const { nome, rhs } of atribuicoes) {
    if (!vinculados.has(nome) && !MARCA_WRAPPER.test(rhs)) refutados.add(nome);
  }

  for (const semente of NOMES_SEMENTE) {
    if (!refutados.has(semente)) vinculados.add(semente);
  }
  return vinculados;
}

function analisarShell(arquivo: string, fonte: string): Sitio[] {
  const limpo = removerComentariosShell(fonte);
  const vinculados = descobrirVinculosShell(limpo);
  const contexto = mascaraContexto(limpo);
  const sitios: Sitio[] = [];

  for (const nome of vinculados) {
    // `"$V"`, `$V`, `"${V}"`, `${V:-…}` — a variável em si, não a marca textual.
    const re = new RegExp(`"?\\$\\{?${nome}\\b`, 'g');
    for (const m of limpo.matchAll(re)) {
      const ini = m.index;
      // Dentro de literal é PROSA (`motivo="… ($PSQL)"`), não invocação.
      if (contexto[ini] !== 1) continue;
      if (!emPosicaoDeComando(limpo.slice(0, ini))) continue;
      const fim = fimDoComando(limpo, ini);
      const trecho = limpo.slice(ini, fim);
      const palavras = fatiarPalavras(trecho);
      const { temC, temF, temErrorStop } = classificarArgumentos(palavras.slice(1));
      const temStdin = recebeDoCano(limpo.slice(0, ini)) || leDeStdin(trecho.slice(palavras[0]?.cru.length ?? 0));
      const opaco = repassaArgumentosOpacos(palavras.slice(1));
      const precisaErrorStop = temF || ((temStdin || opaco) && !temC);
      sitios.push({
        arquivo,
        linha: limpo.slice(0, ini).split('\n').length,
        origem: 'execucao',
        variavel: nome,
        trecho: trecho.trim(),
        temC,
        temF,
        temStdin,
        temErrorStop,
        precisaErrorStop,
        viola: precisaErrorStop && !temErrorStop,
      });
    }
  }
  return sitios.sort((a, b) => a.linha - b.linha);
}

// ──────────────────────────────────── TypeScript ────────────────────────────────────

const EXECUTORES = ['execFileSync', 'spawnSync', 'execFile', 'spawn'];

/** Índice do `)` que fecha o `(` em `ini`, ciente de aspas/template. */
function fimDaChamada(s: string, ini: number): number {
  let prof = 0;
  let i = ini;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const aspas = c;
      let j = i + 1;
      while (j < n) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === aspas) break;
        j++;
      }
      i = j >= n ? n : j + 1;
      continue;
    }
    if (c === '(') prof++;
    if (c === ')') { prof--; if (prof === 0) return i; }
    i++;
  }
  return n;
}

/** Literais de string do trecho — os argumentos do psql em TS são literais. */
function literaisDe(trecho: string): { cru: string; prefixoNu: string }[] {
  const fora: { cru: string; prefixoNu: string }[] = [];
  let i = 0;
  const n = trecho.length;
  while (i < n) {
    const c = trecho[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (trecho[j] === '\\') { j += 2; continue; }
        if (trecho[j] === c) break;
        j++;
      }
      const conteudo = trecho.slice(i + 1, Math.min(j, n));
      fora.push({ cru: conteudo, prefixoNu: conteudo });
      i = j >= n ? n : j + 1;
      continue;
    }
    i++;
  }
  return fora;
}

function descobrirVinculosTs(limpo: string): Set<string> {
  const vinculados = new Set<string>();
  const re = new RegExp(`(?:const|let|var)\\s+(${NOME_VAR})\\s*(?::[^=]+)?=\\s*([^;\\n]*(?:\\n[^;\\n]*)??);`, 'g');
  for (const m of limpo.matchAll(re)) {
    if (MARCA_WRAPPER.test(m[2]) || /PSQL_RO/.test(m[2])) vinculados.add(m[1]);
  }
  return vinculados;
}

function analisarTs(arquivo: string, limpo: string): Sitio[] {
  const vinculados = descobrirVinculosTs(limpo);
  const sitios: Sitio[] = [];
  if (vinculados.size === 0) return sitios;

  const alvo = new RegExp(`\\b(${EXECUTORES.join('|')})\\s*\\(\\s*(${NOME_VAR})\\s*,`, 'g');
  for (const m of limpo.matchAll(alvo)) {
    const nome = m[2];
    if (!vinculados.has(nome)) continue;
    const abre = limpo.indexOf('(', m.index);
    const fim = fimDaChamada(limpo, abre);
    const trecho = limpo.slice(m.index, Math.min(fim + 1, limpo.length));
    const { temC, temF, temErrorStop } = classificarArgumentos(literaisDe(trecho));
    // stdin no Node é a opção `input:` — não há `<` para redirecionar.
    const temStdin = /(^|[^\w.])input\s*:/.test(trecho);
    const precisaErrorStop = temF || (temStdin && !temC);
    sitios.push({
      arquivo,
      linha: limpo.slice(0, m.index).split('\n').length,
      origem: 'execucao',
      variavel: nome,
      trecho: trecho.replace(/\s+/g, ' ').slice(0, 200),
      temC,
      temF,
      temStdin,
      temErrorStop,
      precisaErrorStop,
      viola: precisaErrorStop && !temErrorStop,
    });
  }
  return sitios.sort((a, b) => a.linha - b.linha);
}

// ─────────────────────────────── instrução EMITIDA (TypeScript) ───────────────────────────────
//
// O eixo que faltava (2026-10-01, achado no #2718): o gerador que NÃO executa o wrapper, mas
// IMPRIME o comando que o operador vai rodar — `bun run sonda:sql --so-leitura <edge>… |
// ~/.config/afiacao/psql-ro`. O fiscal lia `execFileSync`, nunca o valor de um literal, e quem
// copiava a instrução herdava o exit 0 com ERROR.

/**
 * A âncora: o CAMINHO do wrapper, que é o que o operador DIGITA para rodá-lo. Prosa usa o NOME
 * (`psql-ro`, 200+ menções no repo) — o mesmo princípio do lado shell: o alvo é o que executa, não
 * a menção. `psql-ro-fake` NÃO casa: é dublê de teste, nunca instrução para operador.
 */
const ANCORA_CAMINHO = /\/\.config\/afiacao\/psql-ro(?![\w-])/g;

/**
 * O PREFIXO que torna a âncora um caminho rodável (`~`, `$HOME`, `${HOME}`, `/Users/…`, uma
 * interpolação), lido para trás a partir dela. Âncora sem prefixo (`'/.config/afiacao/psql-ro'`,
 * agulha de busca) não é caminho de ninguém. O que vem ANTES do prefixo decide vínculo, referência
 * ou comando — por isso `=`, `(`, `|` e aspas ficam fora dele.
 */
const PREFIXO_RODAVEL = /[^\s'"`()|;&<>=,:]+$/;

/** `${…}` de um template, no texto COZIDO: opaco — o fiscal não conhece o valor. */
const INTERPOLACAO_OPACA = '${…}';

/** `PSQL="…/psql-ro"`: o caminho é VÍNCULO; a invocação é a variável, e quem a lê é o lado shell. */
const VINCULO = /[A-Za-z_][A-Za-z0-9_]*=$/;

/** `(caminho)` — o parêntese contém SÓ o caminho: diz onde o wrapper mora, não manda rodá-lo.
 *  `$(`, `<(` e `>(` são substituição de comando/processo, e ali o caminho RODA. */
const ABRE_REFERENCIA = /(?:^|[^$<>])\($/;

interface LiteralLido {
  /** O valor que o programa imprime, com cada interpolação opaca. */
  cozido: string;
  /** A linha (1-based) de cada âncora no texto CRU, em ordem — é onde se acha o literal. */
  linhasDasAncoras: number[];
}

let parserCarregado: typeof TS | undefined;

/**
 * O parser do TypeScript, carregado só quando a fonte traz a âncora: o import custa ~0,65 s por
 * processo, e o harness de falsificação roda este CLI dezenas de vezes por locale — quase sempre
 * sobre fixture shell, que não precisa dele.
 */
function parserTs(): typeof TS {
  parserCarregado ??= createRequire(import.meta.url)('typescript') as typeof TS;
  return parserCarregado;
}

/**
 * Os literais de string e template da fonte, lidos pelo PARSER do TypeScript — e não por um
 * tokenizador local, que teria de concordar com o `removerComentarios` sobre o que é string,
 * template e regex (duas máquinas obrigadas a concordar divergem; aqui elas são CONFERIDAS uma
 * contra a outra, em `analisarEmissoes`). O parser devolve o valor COZIDO: o texto que o operador lê.
 */
function literaisDaFonte(caminho: string, fonte: string): LiteralLido[] {
  const ts = parserTs();
  const tipo = /x$/.test(caminho) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(caminho, fonte, ts.ScriptTarget.Latest, true, tipo);
  const lidos: LiteralLido[] = [];

  const linhasDasAncoras = (partes: TS.Node[]): number[] =>
    partes.flatMap((p) =>
      [...p.getText(sf).matchAll(ANCORA_CAMINHO)].map(
        (m) => sf.getLineAndCharacterOfPosition(p.getStart(sf) + m.index).line + 1,
      ),
    );

  const visitar = (n: TS.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      lidos.push({ cozido: n.text, linhasDasAncoras: linhasDasAncoras([n]) });
    } else if (ts.isTemplateExpression(n)) {
      lidos.push({
        cozido: n.head.text + n.templateSpans.map((s) => INTERPOLACAO_OPACA + s.literal.text).join(''),
        linhasDasAncoras: linhasDasAncoras([n.head, ...n.templateSpans.map((s) => s.literal)]),
      });
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return lidos;
}

/**
 * Classifica cada caminho rodável que um literal IMPRIME. A regra é mais dura que a do shell, e de
 * propósito: instrução emitida sem `-c` lê o SQL de ALGUM lugar — cano, `<`, `-f` ou colagem, e
 * colar num psql é stdin. Num script, `"$PSQL" -tA` sem nada lê o stdin herdado; num texto para o
 * operador, o caminho sem `-c` é o convite a alimentá-lo de SQL.
 */
function analisarEmissoes(
  arquivo: string,
  fonte: string,
  limpo: string,
): { sitios: Sitio[]; indeterminado?: Indeterminado } {
  // Sem a âncora em lugar nenhum da fonte não há o que ler — e o parser nem é carregado.
  if (fonte.match(ANCORA_CAMINHO) === null) return { sitios: [] };

  const literais = literaisDaFonte(arquivo, fonte);

  // CONTAGEM CRUZADA — o alarme de DOIS lados, cada máquina medida POR FORA pela outra. O
  // `removerComentarios` diz quantas âncoras sobram no código sem comentário; o parser diz quantas
  // moram em literal. Se o stripper deixa um comentário (sub-limpeza) ou come uma string
  // (sobre-limpeza), ou se o parser perde um literal, os números divergem — e o fiscal não sabe o
  // que julgou. Divergência é INDETERMINADO, nunca "limpo".
  const noCodigo = limpo.match(ANCORA_CAMINHO)?.length ?? 0;
  const nosLiterais = literais.reduce((t, l) => t + l.linhasDasAncoras.length, 0);
  if (noCodigo !== nosLiterais) {
    return {
      sitios: [],
      indeterminado: {
        arquivo,
        motivo:
          `o caminho do wrapper aparece ${noCodigo}× no código sem comentário (removerComentarios) e ` +
          `${nosLiterais}× em literal (parser do TS) — as duas máquinas discordam sobre onde ele mora`,
      },
    };
  }

  const sitios: Sitio[] = [];
  for (const literal of literais) {
    if (literal.linhasDasAncoras.length === 0) continue;
    let k = 0;
    for (const linhaEmitida of literal.cozido.split('\n')) {
      for (const m of linhaEmitida.matchAll(ANCORA_CAMINHO)) {
        const linha = literal.linhasDasAncoras[Math.min(k++, literal.linhasDasAncoras.length - 1)];
        const prefixo = PREFIXO_RODAVEL.exec(linhaEmitida.slice(0, m.index))?.[0] ?? '';
        if (prefixo === '') continue;
        let antes = linhaEmitida.slice(0, m.index - prefixo.length);
        let depois = linhaEmitida.slice(m.index + m[0].length);
        // `"$HOME/.config/afiacao/psql-ro" -c …` — as aspas são do caminho, não da frase.
        const aspas = antes.at(-1);
        if ((aspas === '"' || aspas === "'") && depois.startsWith(aspas)) {
          antes = antes.slice(0, -1);
          depois = depois.slice(1);
        }
        if (VINCULO.test(antes)) continue;
        if (ABRE_REFERENCIA.test(antes) && depois.startsWith(')')) continue;

        const comando = depois.slice(0, fimDoComando(depois, 0));
        const { temC, temF, temErrorStop } = classificarArgumentos(fatiarPalavras(comando));
        const precisaErrorStop = temF || !temC;
        sitios.push({
          arquivo,
          linha,
          origem: 'emissao',
          variavel: prefixo + m[0],
          trecho: linhaEmitida.trim().slice(0, 200),
          temC,
          temF,
          temStdin: !temC && !temF,
          temErrorStop,
          precisaErrorStop,
          viola: precisaErrorStop && !temErrorStop,
        });
      }
    }
  }
  return { sitios };
}

// ──────────────────────────────────────── fachada ────────────────────────────────────────

export function analisar(arquivos: { caminho: string; fonte: string }[]): Resultado {
  const sitios: Sitio[] = [];
  const emitidos: Sitio[] = [];
  const indeterminados: Indeterminado[] = [];
  let arquivosComVinculo = 0;

  for (const { caminho, fonte } of arquivos) {
    const ehTs = /\.[cm]?tsx?$/.test(caminho);
    const limpo = ehTs ? removerComentarios(fonte) : '';
    const achados = ehTs ? analisarTs(caminho, limpo) : analisarShell(caminho, fonte);
    if (achados.length > 0) arquivosComVinculo++;
    sitios.push(...achados);
    if (!ehTs) continue;

    const emissao = analisarEmissoes(caminho, fonte, limpo);
    emitidos.push(...emissao.sitios);
    if (emissao.indeterminado) indeterminados.push(emissao.indeterminado);
  }

  return {
    sitios,
    emitidos,
    violacoes: [...sitios, ...emitidos].filter((s) => s.viola),
    indeterminados,
    arquivosLidos: arquivos.length,
    arquivosComVinculo,
  };
}
