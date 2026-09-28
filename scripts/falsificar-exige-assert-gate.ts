#!/usr/bin/env bun
/**
 * falsificar-exige-assert-gate.ts — fiscal TEXTUAL do veredito de falsificação: o vermelho que conta
 * como DENTE tem de ser do assert que a sabotagem declara, nunca "a rodada sabotada saiu ≠0". Não
 * executa shell nenhum.
 *
 *   bun scripts/falsificar-exige-assert-gate.ts          # corpo do repo (com pisos e o núcleo)
 *   bun scripts/falsificar-exige-assert-gate.ts <dir…>   # corpo arbitrário (sem piso nem núcleo — é fixture)
 *
 * exit 0 = limpo · 1 = violação · 2 = o fiscal não conseguiu medir (nenhum arquivo lido, piso de
 * denominador furado, manifesto do núcleo ilegível, stripper desabando). 2 NUNCA é "passou". Roda no
 * CI pelo vitest (`falsificar-exige-assert-gate.test.ts`); as mutações que provam o dente de cada
 * camada estão em `scripts/mutcheck.d/falsificar-exige-assert.mut`.
 *
 * ## A classe (docs/historico/falsificacao-exit-nao-e-dente.md)
 *
 * Até 2026-09-27 o `--falsificar` de `db/test-data-health-sync-reprocess.sh` contava como "✅ vermelha
 * como devia" QUALQUER rodada sabotada que saísse ≠0 — inclusive o `exit 9` de uma sabotagem NÃO
 * APLICÁVEL, cuja própria linha "❌ SABOTAGEM NÃO APLICÁVEL" ainda entrava na contagem de asserts
 * quebrados. O recibo saía `SABOTAGENS: 1 vermelhas / 0 falhas`, exit 0 — e o runner do núcleo, que
 * só lê o recibo, aprovaria. A varredura achou a mesma classe em mais 3 juízes do núcleo, cada um no
 * seu idioma: "≠ verde" (que aceitava o SQLSTATE de um ERRO), "ABORTOU" (qualquer exit≠0 do apply)
 * e "rc≠0" (qualquer erro no lugar da recusa).
 *
 * ## As regras
 *
 * R1 · toda lista `SABOTAGENS="…"` (ou `=(…)`) declara, em CADA entrada, o(s) assert(s) que TÊM de
 *      acusá-la: `nome:VERMELHOS`, com `:VERDES` opcional (os que têm de continuar verdes); IDs
 *      alfanuméricos unidos por `,` (E) ou `|` (OU), e `ID!MARCA` quando o vermelho DECLARADO é um erro
 *      de execução com aquela marca (o idioma do #2606). Entrada nua é o defeito; curinga de regex
 *      (`.*`) é o defeito disfarçado — casa qualquer vermelho. Lista vazia não prova nada.
 * R2 · o laço `for X in $SABOTAGENS` extrai a declaração (`${X#*:}`) e ela CHEGA a um `grep` — direto
 *      ou pela cadeia de derivação (`verm="${resto%%:*}"`, `for x in ${verm//,/ }`). Declarar e
 *      descartar é a entrada nua com outra cara.
 * R3 · cada linha `falsificar=<n>` de `db/nucleo-ci.txt` — o recibo que o CI confia sem saber o que é
 *      sabotagem — usa o idioma acima LIMPO (R1/R2 sem violação no arquivo) OU tem um JUIZ registrado
 *      em `JUIZES`: POR QUE o vermelho é do assert, e as âncoras de código sem as quais ele volta a
 *      aceitar qualquer vermelho. Juiz de arquivo não lido reprova.
 *
 * ## O que o texto NÃO alcança, e por quê
 *
 * Fora do núcleo, os laços de falsificação são dezenas, cada um no seu idioma (sentinela, SQLSTATE,
 * conjunto exato de IDs, valor ≠ verde…): uma regra textual única ou os reprovaria em massa ou
 * aprenderia um idioma por arquivo. A varredura de 2026-09-27, site a site, está no diário, e as fases
 * seguintes são tarefa com dono. Âncora também não prova SEMÂNTICA — só torna vermelha a remoção da
 * linha que sustenta o juiz; quem prova o juiz é a meta-falsificação registrada no diário.
 */

import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { diagnosticarShell, removerComentariosShell } from '@/lib/gates/limpeza-shell';
import { PISOS as PISOS_DO_VIZINHO, RAIZES_PADRAO, alarmesDoStripper, enumerar } from './shell-variavel-colada-gate';

/** `import.meta.dir` é do Bun e não existe sob o vitest — por isso preguiçosa, como nos irmãos. */
const raizDoRepo = () => resolve(import.meta.dir, '..');

export const MANIFESTO_NUCLEO = 'db/nucleo-ci.txt';

/**
 * PISOS — o denominador, medido em 2026-09-27. O universo de arquivos é o do vizinho (importado, não
 * copiado: dois números para a mesma calibração divergem). Piso é alarme de fumaça: folgado abaixo do
 * medido, SOBE quando o repo cresce, nunca desce para caber.
 */
export const PISOS = {
  arquivosPorRaiz: PISOS_DO_VIZINHO.arquivosPorRaiz,
  // medidos de novo em 2026-09-27 com a main do #2629 (o gate imprime o denominador: `bun scripts/falsificar-exige-assert-gate.ts`)
  listas: 3, // medido: 7 (eram 4: sync-reprocess, push-vendedora, auto-aprovacao-piloto, positivacao #2606)
  entradas: 40, // medido: 85 (a positivação foi de 14 a 26 com o universo canônico, 20260927195430)
  lacos: 3, // medido: 7
  linhasFalsificarNucleo: 6, // medido: 10 (eram 7: 4 da varredura + transporte-nuvem #2601, tint #2605, positivacao #2606)
} as const;

export interface Juiz {
  /** POR QUE o vermelho que este arquivo conta é do assert — o idioma dele, em uma frase. */
  motivo: string;
  /** Trechos de CÓDIGO (sobrevivem ao stripper) sem os quais o juiz volta a aceitar qualquer vermelho. */
  ancoras: string[];
}

/**
 * Os juízes do núcleo. Obrigatório para toda linha `falsificar=<n>` do manifesto; opcional (mas
 * cobrado igual, âncora por âncora) para os que fazem a falsificação DENTRO da suíte normal e foram
 * consertados na mesma leva — sem o registro, a regressão deles voltaria calada.
 */
export const JUIZES: Readonly<Record<string, Juiz>> = {
  'db/test-data-health-sync-reprocess.sh': {
    motivo:
      'SABOTAGENS nome:A<n> (R1/R2), e a rodada só conta se a sabotagem APLICOU, a suíte rodou INTEIRA e o assert declarado virou de verde para vermelho',
    ancoras: [
      `if ! grep -q 'SABOTAGEM ATIVA em ' "$log"; then`,
      `elif [ "$(executados "$log")" != "$asserts_controle" ]; then`,
      `! grep -Eq "^  ❌ ($exigido) " "$log"`,
      `elif [ "$erros_sql" != "$erros_controle" ]; then`,
      `elif [ -n "$faltam" ]; then`,
    ],
  },
  'db/test-canaria-veredito.sh': {
    motivo:
      'sabota <id> <desc> <marca>: CERTO só com a marca da asserção nos 2 locales; SQL inválido e morte do shell recusados; padrão que não casa invalida',
    ancoras: [`m="$(julga_log "$log" "$marca")"`, `if tem_marca "$1" "$2"; then printf 'CERTO'; else printf "vermelho SEM a marca`, 'padrao nao casou, SQL intacto'],
  },
  'db/test-db-aplicar.sh': {
    motivo: 'confere <rc> <rc-esperado> <log> <marca>…: CERTO só com o rc EXATO e TODAS as marcas; o rc sozinho é recusado',
    ancoras: [
      'confere sem marca: o rc sozinho aceita qualquer vermelho',
      `grep -qF -- "$marca" "$log" || faltam=`,
      `if [ -n "$faltam" ]; then printf 'rc %s certo, SEM a marca`,
    ],
  },
  'db/test-pedido-total-liquido-acervo.sh': {
    motivo:
      'vermelha <rótulo> <valor> <verde> <declarado>: conta só o valor que a sabotagem DECLARA; vermelha_por exige a assinatura do ramo; texto inalterado é falha',
    ancoras: [
      `elif [ "$2" = "$4" ]; then sab_verm`,
      `vermelha_por() { if [ "$2" = "$3" ]; then sab_verm`,
      'a sabotagem não alterou o texto da migration',
      'else sab_falha "$1 — vermelha, mas NÃO no valor que a sabotagem declara',
      '"$(estado_c)" "23514:pedido_venda_coerencia"',
      `elif grep -q 'ERROR:  POSTCONDICAO FALHOU' "$TMPD/post.out"`,
    ],
  },
  'db/test-transporte-nuvem.sh': {
    motivo:
      'sabota <id> <marca>: vermelho só com a marca do assert (`FALHA [T<n>]`) no log, sobre um controle `0 fail` da MESMA invocação; sabotagem que não aplica é falha',
    ancoras: [
      `grep -qE '^RESULTADO: [0-9]+ ok / 0 fail$' "$TMP/controle.log"`,
      `if grep -qF -- "$marca" "$log"; then`,
      `echo "  FALHA $id: vermelho SEM a marca '$marca' (motivo errado)"`,
      'a sabotagem nao aplicou (o texto-alvo mudou?)',
    ],
  },
  // Pré-registrado para o #2605, que o põe no núcleo com `falsificar=12` (o registro de arquivo lido e
  // ancorado vale mesmo antes da linha do manifesto existir).
  'db/test-tint-promocao-assincrona.sh': {
    motivo:
      'fals <nome> <esperado>: vermelho só com o CONJUNTO EXATO de asserts caídos (falhas_de); sabotagem no-op aborta (cmp na migration, RAISE no corpo do promote)',
    ancoras: [
      `got="$(suite "$mig" "$sab" | falhas_de)"`,
      `if [ "$got" = "$esperado" ]; then`,
      'echo "  ✗ $nome: esperado [$esperado], veio [$got]"',
      `if cmp -s "$MIG" "$1"; then echo "✗ sabotagem no-op`,
    ],
  },
  'db/test-authz-revoke-anon-rpc.sh': {
    motivo: 'falsificação na suíte normal: ABORTOU só com a marca da postcondição na saída do apply; outro erro vira "ERRO ALHEIO"',
    ancoras: [`elif grep -q 'ERROR:  POSTCONDICAO FALHOU' "$alvo.out"; then echo "ABORTOU"`, 'else echo "ERRO ALHEIO a postcondicao:'],
  },
  'db/test-pedido-edicao-atomica.sh': {
    motivo:
      'falsificação na suíte normal: rc≠0 só conta com a marca do que a sabotagem DECLARA vir no lugar da recusa (default: a chamada completa)',
    ancoras: [
      'no_lugar="${5:-ASSERT_NAO_LANCOU}"',
      'erro="${out#*ERROR:  }"',
      `*:*"$no_lugar"*)`,
      'bad "$1 — sabotado, mas o vermelho não é o declarado [$no_lugar]',
    ],
  },
};

export type Regra = 'R1' | 'R2' | 'R3';

export interface Violacao {
  regra: Regra;
  arquivo: string;
  linha: number;
  detalhe: string;
}

export interface Analise {
  caminhos: string[];
  listas: number;
  entradas: number;
  lacos: number;
  /** Linhas `falsificar=<n>` lidas do manifesto; `null` = manifesto não fornecido/ilegível. */
  linhasNucleo: number | null;
  violacoes: Violacao[];
  alarmes: string[];
}

/** A atribuição da lista: string entre aspas (duplas ou simples) ou array. `SABOTAGENS=0` não é lista. */
const LISTA =
  /(^|[\s;&|(])(?:(?:local|readonly|export|declare(?:\s+-[A-Za-z]+)*)\s+)?SABOTAGENS=(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))/g;
/** Um ID de assert (`A7`, `T11b`), com `!MARCA` opcional: o erro de execução DECLARADO (#2606). */
const ID = '[A-Za-z0-9_]+(?:![A-Za-z0-9_]+)?';
/** Um grupo: IDs unidos por `,` (E) ou `|` (OU). Nada de curinga. */
const GRUPO = `${ID}(?:[,|]${ID})*`;
/** Uma entrada: `nome:VERMELHOS`, com `:VERDES` opcional — o que tem de continuar verde. */
const ENTRADA = new RegExp(`^[A-Za-z_][A-Za-z0-9_.-]*:${GRUPO}(?::${GRUPO})?$`);
const LACO = /\bfor\s+([A-Za-z_]\w*)\s+in\s+(?:"?\$\{?SABOTAGENS\}?"?|"\$\{SABOTAGENS\[@\]\}")(?=\s*(?:;|\n|do\b))/g;

const linhaDe = (texto: string, indice: number) => texto.slice(0, indice).split('\n').length;

/**
 * O corpo do laço: da linha do `for` até o `done` com a MESMA indentação — grep DEPOIS do laço não
 * julga sabotagem nenhuma (Codex). Laço de uma linha termina nela; recuo irregular cai no fim do
 * arquivo (lê a mais, nunca a menos: o erro fica do lado de não acusar).
 */
function corpoDoLaco(limpo: string, inicio: number): string {
  const fimDaLinha = limpo.indexOf('\n', inicio);
  const linhaDoFor = limpo.slice(inicio, fimDaLinha === -1 ? undefined : fimDaLinha);
  if (/\bdone\b/.test(linhaDoFor)) return linhaDoFor;
  const recuo = limpo.slice(limpo.lastIndexOf('\n', inicio - 1) + 1, inicio);
  const fim = /^[ \t]*$/.test(recuo) ? new RegExp(`\\n${recuo}done\\b`).exec(limpo.slice(inicio)) : null;
  return fim ? limpo.slice(inicio, inicio + fim.index + fim[0].length) : limpo.slice(inicio);
}
const ref = (nome: string) => new RegExp(`\\$\\{?${nome}(?![A-Za-z0-9_])`);
const tiraAspas = (t: string) => t.replace(/^(['"])(.*)\1$/, '$2');

/**
 * R2 para UM laço: a declaração extraída chega a um `grep`? Segue a CADEIA até o ponto fixo: toda
 * variável derivada por expansão de outra da cadeia (`verm="${resto%%:*}"`, `id="${x%%!*}"`) e todo
 * `for` sobre uma delas (`for x in ${verm//,/ }`). O idioma do #2606 tem três elos até o grep.
 */
function lacoConsome(depois: string, v: string): { decl: string | null; chega: boolean } {
  const extracao = new RegExp(`\\b([A-Za-z_]\\w*)="?\\$\\{${v}##?\\*:\\}"?`).exec(depois);
  if (!extracao) return { decl: null, chega: false };
  const cadeia = new Set([extracao[1]]);
  for (let visto = 0; visto !== cadeia.size; ) {
    visto = cadeia.size;
    for (const n of [...cadeia]) {
      const deriva = new RegExp(`\\b([A-Za-z_]\\w*)="?\\$\\{${n}(?![A-Za-z0-9_])`, 'g');
      const itera = new RegExp(`\\bfor\\s+([A-Za-z_]\\w*)\\s+in\\s+[^\\n;]*\\$\\{?${n}(?![A-Za-z0-9_])`, 'g');
      for (const m of depois.matchAll(deriva)) cadeia.add(m[1]);
      for (const m of depois.matchAll(itera)) cadeia.add(m[1]);
    }
  }
  // Continuação `\` junta a linha: `grep -Eq … \` + `"$declarado" "$log"` é UM comando (Codex).
  const comandos = depois.replace(/\\\n/g, ' ').split('\n');
  const chega = comandos.some((l) => /\bgrep\b/.test(l) && [...cadeia].some((n) => ref(n).test(l)));
  return { decl: extracao[1], chega };
}

type Deteccao = { listas: number; entradas: number; lacos: number; violacoes: Violacao[] };

export function detectar(caminho: string, fonte: string): Deteccao {
  return detectarLimpo(caminho, removerComentariosShell(fonte));
}

/** R1 e R2 sobre a fonte JÁ limpa pelo stripper compartilhado (uma passagem só por arquivo). */
function detectarLimpo(caminho: string, limpo: string): Deteccao {
  const violacoes: Violacao[] = [];
  let listas = 0;
  let entradas = 0;
  for (const m of limpo.matchAll(LISTA)) {
    listas++;
    const linha = linhaDe(limpo, (m.index ?? 0) + m[1].length);
    const itens = (m[2] ?? m[3] ?? m[4] ?? '').split(/\s+/).filter(Boolean).map(tiraAspas);
    entradas += itens.length;
    if (itens.length === 0) {
      violacoes.push({ regra: 'R1', arquivo: caminho, linha, detalhe: 'lista SABOTAGENS vazia: a falsificação não sabota nada' });
    }
    for (const item of itens) {
      if (!ENTRADA.test(item)) {
        violacoes.push({
          regra: 'R1',
          arquivo: caminho,
          linha,
          detalhe: `entrada "${item}" não declara o assert que TEM de acusá-la (forma: nome:VERMELHOS[:VERDES], IDs por , ou |, ID!MARCA)`,
        });
      }
    }
  }
  let lacos = 0;
  for (const m of limpo.matchAll(LACO)) {
    lacos++;
    const inicio = m.index ?? 0;
    const linha = linhaDe(limpo, inicio);
    const { decl, chega } = lacoConsome(corpoDoLaco(limpo, inicio), m[1]);
    if (decl === null) {
      violacoes.push({
        regra: 'R2',
        arquivo: caminho,
        linha,
        detalhe: `o laço "for ${m[1]} in $SABOTAGENS" descarta a declaração (nenhum \${${m[1]}#*:}): o veredito volta a ser o exit`,
      });
    } else if (!chega) {
      violacoes.push({
        regra: 'R2',
        arquivo: caminho,
        linha,
        detalhe: `a declaração "${decl}" nunca chega a um grep do log: o laço a extrai e julga por outra coisa`,
      });
    }
  }
  if (listas > 0 && lacos === 0) {
    violacoes.push({ regra: 'R2', arquivo: caminho, linha: 1, detalhe: 'lista SABOTAGENS que nenhum laço "for X in $SABOTAGENS" percorre' });
  }
  return { listas, entradas, lacos, violacoes };
}

/** As linhas `falsificar=<n>` do manifesto (fora-do-ci não entra: o CI não lê recibo nenhum dali). */
export function lerNucleo(manifesto: string): { arquivo: string; linha: number }[] {
  return manifesto
    .split('\n')
    .map((l, i) => ({ l: l.trim(), linha: i + 1 }))
    .filter(({ l }) => !l.startsWith('#'))
    .map(({ l, linha }) => ({ m: /^(\S+)\s+\d+\s+falsificar=\d+(?:\s|$)/.exec(l), linha }))
    .filter((x): x is { m: RegExpExecArray; linha: number } => x.m !== null)
    .map(({ m, linha }) => ({ arquivo: m[1], linha }));
}

/**
 * R3: cada `falsificar=<n>` usa o idioma LIMPO (se prova sozinho pelo R1/R2) ou tem juiz; cada juiz
 * registrado foi lido e tem TODAS as âncoras no código.
 */
export function julgarNucleo(
  nucleo: { arquivo: string; linha: number }[],
  limpos: ReadonlyMap<string, string>,
  juizes: Readonly<Record<string, Juiz>>,
  idiomaLimpo: ReadonlySet<string> = new Set(),
): Violacao[] {
  const v: Violacao[] = [];
  for (const { arquivo, linha } of nucleo) {
    if (!(arquivo in juizes) && !idiomaLimpo.has(arquivo)) {
      v.push({
        regra: 'R3',
        arquivo: MANIFESTO_NUCLEO,
        linha,
        detalhe: `${arquivo} tem falsificar=<n> sem o idioma SABOTAGENS limpo e sem JUIZ registrado: o CI confiaria no recibo sem saber se o vermelho é do assert`,
      });
    }
  }
  for (const [arquivo, juiz] of Object.entries(juizes)) {
    const limpo = limpos.get(arquivo);
    if (limpo === undefined) {
      v.push({ regra: 'R3', arquivo, linha: 1, detalhe: 'juiz registrado para arquivo que o fiscal não leu (renomeado? removido?)' });
      continue;
    }
    for (const ancora of juiz.ancoras) {
      if (!limpo.includes(ancora)) {
        v.push({ regra: 'R3', arquivo, linha: 1, detalhe: `âncora do juiz sumiu do código: ${ancora} — (${juiz.motivo})` });
      }
    }
  }
  return v;
}

export function analisar(
  arquivos: { caminho: string; fonte: string }[],
  manifesto: string | null = null,
  juizes: Readonly<Record<string, Juiz>> = JUIZES,
): Analise {
  const r: Analise = { caminhos: [], listas: 0, entradas: 0, lacos: 0, linhasNucleo: null, violacoes: [], alarmes: [] };
  const limpos = new Map<string, string>();
  /** Os arquivos que se provam sozinhos: têm lista SABOTAGENS e nenhuma violação de R1/R2. */
  const idiomaLimpo = new Set<string>();
  for (const a of arquivos) {
    const limpo = removerComentariosShell(a.fonte);
    const d = detectarLimpo(a.caminho, limpo);
    r.caminhos.push(a.caminho);
    r.listas += d.listas;
    r.entradas += d.entradas;
    r.lacos += d.lacos;
    r.violacoes.push(...d.violacoes);
    if (d.listas > 0 && d.violacoes.length === 0) idiomaLimpo.add(a.caminho);
    r.alarmes.push(...alarmesDoStripper(a.caminho, diagnosticarShell(a.fonte)));
    limpos.set(a.caminho, limpo);
  }
  if (manifesto !== null) {
    const nucleo = lerNucleo(manifesto);
    r.linhasNucleo = nucleo.length;
    r.violacoes.push(...julgarNucleo(nucleo, limpos, juizes, idiomaLimpo));
  }
  return r;
}

export function veredito(r: Analise, comPisos: boolean): { codigo: 0 | 1 | 2; linhas: string[] } {
  const furos = r.alarmes.map((a) => `stripper desabando — ${a}`);
  if (r.caminhos.length === 0) furos.push('nenhum arquivo shell lido');
  if (comPisos) {
    for (const [raiz, piso] of Object.entries(PISOS.arquivosPorRaiz)) {
      const lidos = r.caminhos.filter((c) => c.startsWith(`${raiz}/`)).length;
      if (lidos < piso) furos.push(`${lidos} arquivo(s) shell em ${raiz}/ < piso ${piso}`);
    }
    if (r.listas < PISOS.listas) furos.push(`${r.listas} lista(s) SABOTAGENS vista(s) < piso ${PISOS.listas}`);
    if (r.entradas < PISOS.entradas) furos.push(`${r.entradas} entrada(s) de sabotagem vista(s) < piso ${PISOS.entradas}`);
    if (r.lacos < PISOS.lacos) furos.push(`${r.lacos} laço(s) sobre SABOTAGENS visto(s) < piso ${PISOS.lacos}`);
    if (r.linhasNucleo === null) furos.push(`manifesto do núcleo (${MANIFESTO_NUCLEO}) não foi lido`);
    else if (r.linhasNucleo < PISOS.linhasFalsificarNucleo) {
      furos.push(`${r.linhasNucleo} linha(s) falsificar=<n> no núcleo < piso ${PISOS.linhasFalsificarNucleo} — o formato mudou?`);
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
        `❌ ${r.violacoes.length} veredito(s) de falsificação que aceitariam um vermelho que não é do assert:`,
        ...r.violacoes.map((v) => `  [${v.regra}] ${v.arquivo}:${v.linha}  ${v.detalhe}`),
        '',
        '  Exit≠0 não é dente: o vermelho tem de ser do SEU assert (docs/agent/money-path.md). Cada sabotagem',
        '  declara o assert que TEM de acusá-la e o laço exige ESSE assert no log — sabotagem não aplicável ou',
        '  vermelha por outro motivo é FALHA. docs/historico/falsificacao-exit-nao-e-dente.md',
      ],
    };
  }
  const censo = comPisos ? `, ${r.linhasNucleo} linha(s) falsificar=<n> do núcleo julgada(s) (idioma limpo ou juiz)` : '';
  return {
    codigo: 0,
    linhas: [
      `✅ falsificar/exige-assert: ${r.caminhos.length} arquivo(s) shell, ${r.listas} lista(s) SABOTAGENS com ` +
        `${r.entradas} entrada(s) declaradas e ${r.lacos} laço(s) que consomem a declaração${censo}.`,
    ],
  };
}

/** O corpo que o CI julga: todo shell das raízes padrão + o manifesto do núcleo. O teste lê por AQUI. */
export function lerCorpoDoRepo(base: string): { arquivos: { caminho: string; fonte: string }[]; manifesto: string | null } {
  const arquivos = enumerar(RAIZES_PADRAO, base).map((c) => ({ caminho: relative(base, c), fonte: readFileSync(c, 'utf8') }));
  let manifesto: string | null = null;
  try {
    manifesto = readFileSync(join(base, MANIFESTO_NUCLEO), 'utf8');
  } catch {
    manifesto = null; // quem acusa é o veredito (INDETERMINADO), não o silêncio daqui
  }
  return { arquivos, manifesto };
}

function main(): number {
  const argv = process.argv.slice(2);
  const { arquivos, manifesto } =
    argv.length === 0
      ? lerCorpoDoRepo(raizDoRepo())
      : {
          arquivos: enumerar(argv, process.cwd()).map((c) => ({ caminho: relative(process.cwd(), c), fonte: readFileSync(c, 'utf8') })),
          manifesto: null,
        };
  const { codigo, linhas } = veredito(analisar(arquivos, manifesto), argv.length === 0);
  if (codigo === 0) console.log(linhas.join('\n'));
  else console.error(linhas.join('\n'));
  return codigo;
}

if (import.meta.main) process.exit(main());
