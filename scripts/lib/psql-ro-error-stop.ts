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
 */

import { removerComentarios } from '@/lib/gates/limpeza-fonte';
import { fatiarPalavras, mascaraContexto, removerComentariosShell } from '@/lib/gates/limpeza-shell';

/** Nomes SEMENTE: usados sem `=` no arquivo, herdados do ambiente. Um `=` local que aponte para
 *  outra coisa REFUTA a semente naquele arquivo (é assim que `PSQL="$PGBIN/psql"` não vira alvo). */
export const NOMES_SEMENTE = ['PSQL', 'PSQL_RO', 'PSQLRO', 'AFIACAO_PSQL'] as const;

/** Marca do wrapper num RHS. `psql-ro-fake` casa de propósito: o fake IMITA prod (sem
 *  ON_ERROR_STOP), então lê-lo por `-f` tem exatamente o mesmo defeito. */
const MARCA_WRAPPER = /psql-ro/;

export interface Sitio {
  arquivo: string;
  linha: number;
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

export interface Resultado {
  sitios: Sitio[];
  violacoes: Sitio[];
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

export interface Classificacao {
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

export function analisarShell(arquivo: string, fonte: string): Sitio[] {
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
      const temStdin = leDeStdin(trecho.slice(palavras[0]?.cru.length ?? 0));
      const opaco = repassaArgumentosOpacos(palavras.slice(1));
      const precisaErrorStop = temF || ((temStdin || opaco) && !temC);
      sitios.push({
        arquivo,
        linha: limpo.slice(0, ini).split('\n').length,
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

export function descobrirVinculosTs(limpo: string): Set<string> {
  const vinculados = new Set<string>();
  const re = new RegExp(`(?:const|let|var)\\s+(${NOME_VAR})\\s*(?::[^=]+)?=\\s*([^;\\n]*(?:\\n[^;\\n]*)??);`, 'g');
  for (const m of limpo.matchAll(re)) {
    if (MARCA_WRAPPER.test(m[2]) || /PSQL_RO/.test(m[2])) vinculados.add(m[1]);
  }
  return vinculados;
}

export function analisarTs(arquivo: string, fonte: string): Sitio[] {
  const limpo = removerComentarios(fonte);
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

// ──────────────────────────────────────── fachada ────────────────────────────────────────

export function analisar(arquivos: { caminho: string; fonte: string }[]): Resultado {
  const sitios: Sitio[] = [];
  let arquivosComVinculo = 0;

  for (const { caminho, fonte } of arquivos) {
    const ehTs = /\.[cm]?tsx?$/.test(caminho);
    const achados = ehTs ? analisarTs(caminho, fonte) : analisarShell(caminho, fonte);
    if (achados.length > 0) arquivosComVinculo++;
    sitios.push(...achados);
  }

  return {
    sitios,
    violacoes: sitios.filter((s) => s.viola),
    arquivosLidos: arquivos.length,
    arquivosComVinculo,
  };
}
