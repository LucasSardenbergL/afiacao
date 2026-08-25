#!/usr/bin/env bun
/**
 * canaria-contrato-bump-gate.ts — o `contrato` da canária tem de acompanhar o que ela ATESTA.
 * ============================================================================================
 *
 * ## O buraco que ele tapa — e ele já foi MEDIDO por outra sessão
 *
 * O `sonda-versao-bump-gate.ts` (#1993) fecha a OMISSÃO de bump do `VERSAO` das sondas, e só as
 * sondas. A auditoria dos 7 `contrato` de canária (`5d8f1f779`, §"O escopo que ficou aberto" de
 * `docs/historico/sonda-marcador-congelado.md`) concluiu que **nenhum está congelado hoje** e que
 * "o furo que a auditoria achou não é um contrato parado — é a **falta de gate**". Este é o gate.
 *
 * O caso concreto que aquela auditoria nomeia: o `f6561b0b2` instalou 4 guards money-path na
 * `carteira-rebuild` (`data == null` sem `error` passa a `failLease` em vez de encerrar o laço com a
 * carteira TRUNCADA) e o `trava-saida-v1` é de 8 dias antes — a canária responde a mesma string com
 * ou sem os guards. **Este gate o reprova:** `--base f6561b0b2^ --head f6561b0b2` sai com exit 1
 * nomeando a edge. Ele está 21 fatias FORA da janela de 400 medida abaixo, então é controle
 * positivo histórico, não amostra da medição.
 *
 * A classe: a canária compara `resolved` (o que o código DEPLOYADO produz sobre a fixture) com
 * `expected` (um literal do MESMO bundle). Os dois viajam juntos — então um deploy integralmente
 * velho compara velho×velho e responde `ok:true`, mentindo verde. O que separa "respondeu" de "é a
 * versão que eu deployei" é só o `contrato`. Congelado, ele responde a mesma string tendo o deploy
 * acontecido ou não.
 *
 * Que a classe é real AQUI está provado: o #1974 (`97194df1b`) bumpou o `contrato` da
 * `omie-vendas-sync` de `identidade-fail-closed-v1` para `identidade-a2-client-to-user-v2` porque
 * o marcador velho não nomeava mais a fatia que a canária verifica.
 *
 * ## O `contrato` tem DOIS trabalhos — e é isso que decide a régua
 *
 * (a) **identificar o bundle** ("qual build respondeu?");
 * (b) **nomear o contrato** que a canária verifica ("o que este verde está afirmando?").
 *
 * Onde a edge TEM sonda (`versao.ts` com `VERSAO`), o trabalho (a) já é do `sonda:bump` — e desde o
 * #1998 é também do `fonte` SERVIDO pelo fingerprint, que discrimina o bundle sem depender de
 * disciplina nenhuma. Exigir que o `contrato` bumpe também por mudança em qualquer canto do corpo
 * seria pedir o TERCEIRO marcador pelo mesmo motivo, no mesmo PR. Onde a edge NÃO tem sonda, ela
 * também está fora do mapa de fingerprints (medido em `5d8f1f779`: as 2 sem sonda são exatamente as
 * 2 fora do mapa), então o `contrato` é o ÚNICO marcador de bundle que existe — e aí a régua tem de
 * ser a mesma do irmão.
 *
 * Logo, duas réguas, escolhidas pelo que a edge tem:
 *
 *   · **sem `versao.ts`** (`carteira-rebuild`, `omie-vendas-sync`) → régua = CORPO SERVIDO inteiro,
 *     idêntica à do `sonda:bump`, com o `contrato` no lugar do `VERSAO`;
 *   · **com `versao.ts`** (`analyze-unified-order`, `omie-analytics-sync`, `omie-financeiro`) →
 *     régua = **superfície da canária**: o bloco dela MAIS o fecho transitivo dos símbolos que o
 *     bloco alcança (fixtures, `expected` e as funções SOB TESTE, inclusive as de `_shared/`).
 *
 * ## A medição que escolheu a régua (400 fatias de `main`, com o próprio gate decidindo)
 *
 * | régua | reprovaria | veredito |
 * |---|---|---|
 * | corpo servido inteiro, para TODA canária | **8** pares em 10 fatias | ERRADA — 7 das 8 mudam parte da edge que a canária não atesta (o #1938 mexeu no prompt, não no `mergeCustomerPrices`) |
 * | só o BLOCO da canária | 0 | cega para o código SOB TESTE, que é o que a canária existe para atestar |
 * | **a de cima, dividida por "tem sonda?"** | **2** | as duas abaixo |
 *
 * As duas reprovações são da régua de CORPO SERVIDO, nas duas edges que naquela fatia ainda não
 * tinham sonda — logo o `contrato` era o único marcador de bundle que elas tinham:
 *
 *   · `5f5523df9` (#1694) — `carteira-rebuild`, trocou `npm:@supabase/supabase-js@^2` por `npm:…@2`;
 *   · `2eb237532` (#1685) — `omie-financeiro`, trocou `deno.land/std/http/server` por `Deno.serve`
 *     (a `versao.ts` dela só nasceu no `5b8501144`, 16 dias DEPOIS).
 *
 * As duas são a MESMA fronteira que o irmão já assumiu no `dc67b4261` ("encanamento", não fluxo):
 * mudança observável no bundle servido, e a assimetria manda errar para este lado — um marcador a
 * mais custa uma linha, um deploy inverificável de money-path custa o documento inteiro.
 *
 * Nas mesmas 400 fatias houve UM bump legítimo, o do #1974, e a régua o reconhece como bump (não
 * como reprovação). É o controle positivo pelo lado verde.
 *
 * ⚠️ **A régua é escolhida pelo HEAD, então instalar uma sonda AFROUXA este gate na mesma fatia** —
 * e é coerente, não furo: o `VERSAO` que nasce é uma string que nunca respondeu em prod, então a
 * discriminação de bundle passa a existir por construção, que é o mesmo motivo pelo qual o irmão
 * deixa passar a edge que NASCE instrumentada. O `contrato` continua respondendo pelo trabalho (b).
 *
 * ⚠️ **`_shared/` entra AQUI, e isso não contradiz o irmão — a granularidade é outra.** O
 * `sonda:bump` mede `_shared/` por ARQUIVO e por isso o exclui: cobri-lo daria 290 pares
 * (edge, fatia) em 25 fatias, ~12 bumps por PR. Este gate resolve `_shared/` por **símbolo**: só
 * entra na superfície a função que a canária de fato exercita. Medido: incluir `_shared/` assim
 * custa **zero** reprovação a mais nas mesmas 400 fatias, e é o que põe `desfechoVarreduraReversa`
 * e `fingerprintPagina` (que a `paginacao_probe` testa e que moram em `_shared/omie-paginacao.ts`)
 * dentro do que o gate enxerga. Sem isso, essa canária ficaria coberta só pelas próprias fixtures.
 *
 * ## Fail-CLOSED
 *
 * Sem base determinável, ou com uma emissão de `contrato` cujo bloco não dá para delimitar, o gate
 * REPROVA. Gate que degrada para verde quando não consegue medir é indistinguível de verde por
 * mérito.
 *
 * ⚠️ **Limite conhecido, declarado em vez de descoberto depois.** A superfície é resolvida por
 * TEXTO (definições de topo casadas por nome), não por um resolvedor de módulos: símbolo
 * re-exportado por um terceiro módulo, ou montado em runtime, não entra. O que converte isso de
 * suposição em medida é a CALIBRAÇÃO do teste irmão, que sabota cada função sob teste e exige que a
 * superfície mude — se o índice de definições quebrar, o teste fica vermelho antes de o gate ficar
 * cego. E, como no irmão, omissão ANTIGA não é descoberta: o gate é de transição.
 *
 * ⚠️ **O que este gate NÃO alcança, e onde o próximo esforço rende.** Nas duas edges sem sonda, a
 * régua de corpo servido cobre o diretório da edge e **não** `_shared/` — e elas também não têm o
 * fingerprint do #1998. Uma mudança de comportamento que chegue por `_shared/` nessas duas continua
 * sem marcador que se mexa. O desenho que resolve já está no repo, na `generate-tactical-plan`:
 * servir o marcador da canária no campo `versao`, o MESMO símbolo da sonda, faz a canária herdar o
 * `sonda:bump` E o fingerprint de graça. Custo declarado em `5d8f1f779`: quem verificar pelo nome
 * `contrato` passa a ler `undefined`, então a mudança tem de ir junto com a §Canárias do
 * `deploy.md`.
 *
 * Uso:
 *   bun run canaria:bump                        # base = merge-base com origin/main (ou GITHUB_BASE_REF)
 *   bun scripts/canaria-contrato-bump-gate.ts --base <rev> [--head <rev>]
 *   SONDA_BASE=<rev> bun run canaria:bump       # mesma env do irmão: é a MESMA fatia
 */
import { removerComentarios } from '@/lib/gates/limpeza-fonte';
import {
  auditarBump,
  contaComoCorpo,
  extrairVersao,
  git,
  lerNaRev,
  lerNoHead,
  normalizarFonte,
  RAIZ_EDGES,
  resolverBase,
  type ArquivoCorpo,
  type EstadoEdge,
} from './sonda-versao-bump-gate';

/** o `versao.ts` da sonda — a presença dele é o que escolhe a régua */
const ARQ_SONDA = 'versao.ts';

/** a emissão do marcador da canária, na resposta que ela devolve */
const RE_EMISSAO = /contrato\s*:\s*(["'])([^"'\n]+)\1/;

/**
 * Abertura do ARM que hospeda a canária. As canárias deste repo têm duas formas só:
 * `case "<rota>": {` (probe roteada por `action`) e `if (<gate da canária>) {`.
 */
const RE_ARM = /^(\s*)(?:case\s+(["'])([^"']+)\2\s*:|if\s*\()/;

/**
 * Definição de TOPO (coluna 0). É o que o fecho de símbolos casa por nome — helper aninhado dentro
 * de outra função não entra, e isso está no limite declarado do cabeçalho.
 */
const RE_DEF =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*[:=]|let\s+(\w+)\s*[:=]|class\s+(\w+)|type\s+(\w+)\b|interface\s+(\w+)\b|enum\s+(\w+)\b)/;

/** identificador JS — o alfabeto do fecho */
const RE_IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** profundidade do fecho. 6 é folgado: a cadeia mais longa medida hoje tem 3. */
const PROFUNDIDADE_FECHO = 6;

export interface Canaria {
  /** chave estável para parear base×HEAD: `case:<rota>` ou `if:<ordinal no arquivo>` */
  chave: string;
  /** o marcador emitido */
  contrato: string;
  /** o arm que hospeda a canária, já sem comentário; null = não deu para delimitar → fail-CLOSED */
  bloco: string | null;
}

export type MotivoCanaria = 'sem-bump' | 'bloco-indelimitavel';

export interface AchadoCanaria {
  edge: string;
  chave: string;
  contrato: string;
  motivo: MotivoCanaria;
  /** qual das duas réguas julgou — entra na mensagem porque muda o que o autor precisa fazer */
  regua: 'corpo-servido' | 'superficie-da-canaria';
}

const indentacao = (linha: string): number => linha.length - linha.trimStart().length;

/**
 * Localiza cada emissão de `contrato` e o ARM que a hospeda.
 *
 * O bloco é delimitado por INDENTAÇÃO, não por contagem de chaves: chave dentro de string e dentro
 * de interpolação de template são comuns nestas edges, e contá-las sem tokenizador daria fronteira
 * errada exatamente no arquivo mais quente. A entrada já vem sem comentário (o stripper
 * COMPARTILHADO preserva a contagem de linhas de propósito), então abertura de comentário dentro de
 * string não desloca nada.
 *
 * Sobem-se os candidatos a arm do mais PRÓXIMO ao mais distante, e aceita-se o primeiro cujo bloco
 * ainda não fechou na linha da emissão — é isso que faz um `if` interno que fecha antes ser
 * descartado, e o `case` da rota vencer.
 */
export function localizarCanarias(fonteSemComentario: string): Canaria[] {
  const linhas = fonteSemComentario.split('\n');
  const achadas: Canaria[] = [];
  let ordinalIf = 0;
  for (let i = 0; i < linhas.length; i++) {
    const emissao = linhas[i].match(RE_EMISSAO);
    if (!emissao) continue;
    const indEmissao = indentacao(linhas[i]);
    let canaria: Canaria | null = null;
    for (let j = i - 1; j >= 0 && canaria === null; j--) {
      if (linhas[j].trim() === '' || indentacao(linhas[j]) >= indEmissao) continue;
      const arm = linhas[j].match(RE_ARM);
      if (!arm) continue;
      const indArm = arm[1].length;
      let fim = linhas.length - 1;
      for (let k = j + 1; k < linhas.length; k++) {
        if (linhas[k].trim() === '') continue;
        if (indentacao(linhas[k]) <= indArm) {
          fim = k;
          break;
        }
      }
      if (fim <= i) continue; // arm que fechou ANTES da emissão: não é o dela
      canaria = {
        chave: arm[3] ? `case:${arm[3]}` : `if:${++ordinalIf}`,
        contrato: emissao[2],
        bloco: linhas.slice(j, fim + 1).join('\n'),
      };
    }
    achadas.push(canaria ?? { chave: `emissao:${i + 1}`, contrato: emissao[2], bloco: null });
  }
  return achadas;
}

/**
 * Índice `símbolo → corpo` sobre as definições de topo dos arquivos dados.
 *
 * O corpo indexado carrega o CAMINHO no cabeçalho: mover um helper de arquivo muda a superfície, e
 * deve mudar mesmo — o bundle mudou. Primeira definição vence, para o índice ser determinístico.
 */
export function indexarDefinicoes(fontesSemComentario: Map<string, string>): Map<string, string> {
  const indice = new Map<string, string>();
  for (const [caminho, fonte] of [...fontesSemComentario].sort()) {
    const linhas = fonte.split('\n');
    for (let i = 0; i < linhas.length; i++) {
      if (linhas[i].trim() === '' || indentacao(linhas[i]) !== 0) continue;
      const def = linhas[i].match(RE_DEF);
      if (!def) continue;
      const nome = def.slice(1).find((g) => g !== undefined)!;
      let fim = i;
      for (let k = i + 1; k < linhas.length; k++) {
        if (linhas[k].trim() === '') continue;
        if (indentacao(linhas[k]) > 0) {
          fim = k;
          continue;
        }
        // Linha na coluna 0 que só FECHA o que está aberto ainda é esta definição.
        if (/^[}\])`;,]/.test(linhas[k])) {
          fim = k;
          continue;
        }
        break;
      }
      if (!indice.has(nome)) {
        indice.set(
          nome,
          `${caminho}::${nome}\n${normalizarFonte(linhas.slice(i, fim + 1).join('\n'))}`,
        );
      }
      i = fim;
    }
  }
  return indice;
}

function identificadores(texto: string): string[] {
  return [...new Set(texto.match(RE_IDENT) ?? [])];
}

/**
 * A superfície que o `contrato` nomeia: o bloco da canária MAIS o fecho transitivo das definições
 * que ele alcança por nome. É o que responde "o que esta canária atesta?" — fixtures, `expected` e
 * as funções SOB TESTE, que é onde mora o comportamento que o marcador promete.
 */
export function superficieCanaria(bloco: string, definicoes: Map<string, string>): string {
  const vistos = new Set<string>();
  const partes: string[] = [];
  let fronteira = identificadores(bloco);
  for (let nivel = 0; nivel < PROFUNDIDADE_FECHO && fronteira.length > 0; nivel++) {
    const proxima = new Set<string>();
    for (const nome of [...fronteira].sort()) {
      if (vistos.has(nome)) continue;
      vistos.add(nome);
      const corpo = definicoes.get(nome);
      if (corpo === undefined) continue;
      partes.push(corpo);
      for (const alcancado of identificadores(corpo)) {
        if (!vistos.has(alcancado)) proxima.add(alcancado);
      }
    }
    fronteira = [...proxima];
  }
  return `${normalizarFonte(bloco)}\n@\n${partes.sort().join('\n@\n')}`;
}

export interface EstadoCanaria {
  edge: string;
  chave: string;
  regua: AchadoCanaria['regua'];
  contratoBase: string | null;
  contratoHead: string;
  /** o que a régua compara — corpo servido real, ou a superfície da canária como pseudo-arquivo */
  corpo: ArquivoCorpo[];
  /** o bloco do HEAD não deu para delimitar: não medir não é o mesmo que estar em ordem */
  indelimitavel?: boolean;
}

/**
 * Núcleo puro. Delega o julgamento a `auditarBump` do gate irmão DE PROPÓSITO: as duas metades
 * fazem a mesma pergunta ("o corpo mudou e o marcador não?") e ter duas implementações dela seria
 * ter duas respostas possíveis para o mesmo PR. O que muda aqui é o que entra como corpo e o que
 * conta como marcador — não a regra.
 */
export function auditarContratos(canarias: EstadoCanaria[]): AchadoCanaria[] {
  const achados: AchadoCanaria[] = [];
  for (const c of canarias) {
    if (c.indelimitavel) {
      achados.push({
        edge: c.edge,
        chave: c.chave,
        contrato: c.contratoHead,
        motivo: 'bloco-indelimitavel',
        regua: c.regua,
      });
      continue;
    }
    const estado: EstadoEdge = {
      edge: c.edge,
      versaoBase: c.contratoBase,
      versaoHead: c.contratoHead,
      corpo: c.corpo,
    };
    if (auditarBump([estado]).length === 0) continue;
    achados.push({
      edge: c.edge,
      chave: c.chave,
      contrato: c.contratoHead,
      motivo: 'sem-bump',
      regua: c.regua,
    });
  }
  return achados;
}

// ─── I/O: git ────────────────────────────────────────────────────────────────────────────────

/** marcador interno para "o lado HEAD", que pode ser uma rev ou o working tree */
const LADO_HEAD = ' head';

const CACHE_FONTE = new Map<string, string | null>();

function lerLado(rev: string, caminho: string, headRev: string | null): string | null {
  const chave = `${rev === LADO_HEAD ? (headRev ?? 'wt') : rev}:${caminho}`;
  if (!CACHE_FONTE.has(chave)) {
    CACHE_FONTE.set(
      chave,
      rev === LADO_HEAD ? lerNoHead(headRev, caminho) : lerNaRev(rev, caminho),
    );
  }
  return CACHE_FONTE.get(chave)!;
}

function arquivosDoLado(rev: string, headRev: string | null, dir: string): string[] {
  const alvo = rev === LADO_HEAD ? (headRev ?? 'HEAD') : rev;
  const { ok, saida } = git(['ls-tree', '-r', '--name-only', alvo, '--', dir]);
  return ok ? saida.split('\n').filter((l) => l !== '') : [];
}

/**
 * O caminho é fonte que o fecho pode ALCANÇAR a partir do bloco desta canária: o corpo servido da
 * edge (mesma definição do gate irmão) mais `_shared/*.ts` não-teste.
 *
 * Exportado porque o teste de CALIBRAÇÃO monta o mesmo conjunto lendo o disco: se ele usasse uma
 * lista própria, a sabotagem provaria a resolução de um universo que não é o que o gate mede — e a
 * calibração viraria teatro.
 */
export function contaComoFonteVisivel(caminho: string, edge: string): boolean {
  if (contaComoCorpo(caminho, edge)) return true;
  if (!caminho.startsWith(`${RAIZ_EDGES}/_shared/`)) return false;
  if (/(?:_test|\.test)\.[cm]?[jt]sx?$/.test(caminho)) return false;
  return caminho.endsWith('.ts');
}

/** Fontes visíveis numa rev, já sem comentário — a entrada de `indexarDefinicoes`. */
function fontesVisiveis(rev: string, headRev: string | null, edge: string): Map<string, string> {
  const fontes = new Map<string, string>();
  for (const dir of [`${RAIZ_EDGES}/${edge}`, `${RAIZ_EDGES}/_shared`]) {
    for (const caminho of arquivosDoLado(rev, headRev, dir)) {
      if (!contaComoFonteVisivel(caminho, edge)) continue;
      const f = lerLado(rev, caminho, headRev);
      if (f !== null) fontes.set(caminho, removerComentarios(f));
    }
  }
  return fontes;
}

/** Coleta o estado das canárias que a fatia pode ter afetado. */
export function coletarEstadoCanarias(base: string, headRev: string | null): EstadoCanaria[] {
  const edges = [
    ...new Set(
      arquivosDoLado(LADO_HEAD, headRev, RAIZ_EDGES).map(
        (p) => p.slice(RAIZ_EDGES.length + 1).split('/')[0],
      ),
    ),
  ].filter((d) => d !== '_shared');

  const estados: EstadoCanaria[] = [];
  for (const edge of edges.sort()) {
    const indexHead = lerLado(LADO_HEAD, `${RAIZ_EDGES}/${edge}/index.ts`, headRev);
    if (indexHead === null) continue;
    const canariasHead = localizarCanarias(removerComentarios(indexHead));
    if (canariasHead.length === 0) continue;

    const indexBase = lerNaRev(base, `${RAIZ_EDGES}/${edge}/index.ts`);
    const canariasBase = new Map(
      (indexBase === null ? [] : localizarCanarias(removerComentarios(indexBase))).map((c) => [
        c.chave,
        c,
      ]),
    );

    // A régua sai daqui: sonda presente ⇒ o `VERSAO` já responde "qual bundle?"; ausente ⇒ o
    // `contrato` é o único marcador que existe, e a régua tem de ser a mesma do gate irmão.
    const fonteSonda = lerLado(LADO_HEAD, `${RAIZ_EDGES}/${edge}/${ARQ_SONDA}`, headRev);
    const temSonda = fonteSonda !== null && extrairVersao(fonteSonda) !== null;
    const regua: AchadoCanaria['regua'] = temSonda ? 'superficie-da-canaria' : 'corpo-servido';

    const defsHead = temSonda
      ? indexarDefinicoes(fontesVisiveis(LADO_HEAD, headRev, edge))
      : new Map<string, string>();
    const defsBase = temSonda
      ? indexarDefinicoes(fontesVisiveis(base, headRev, edge))
      : new Map<string, string>();

    const corpoServido: ArquivoCorpo[] = temSonda
      ? []
      : [
          ...new Set([
            ...arquivosDoLado(base, headRev, `${RAIZ_EDGES}/${edge}`),
            ...arquivosDoLado(LADO_HEAD, headRev, `${RAIZ_EDGES}/${edge}`),
          ]),
        ]
          .filter((caminho) => contaComoCorpo(caminho, edge))
          .sort()
          .map((caminho) => ({
            caminho,
            base: lerNaRev(base, caminho),
            head: lerLado(LADO_HEAD, caminho, headRev),
          }));

    for (const canaria of canariasHead) {
      const naBase = canariasBase.get(canaria.chave) ?? null;
      if (canaria.bloco === null) {
        estados.push({
          edge,
          chave: canaria.chave,
          regua,
          contratoBase: naBase?.contrato ?? null,
          contratoHead: canaria.contrato,
          corpo: [],
          indelimitavel: true,
        });
        continue;
      }
      estados.push({
        edge,
        chave: canaria.chave,
        regua,
        contratoBase: naBase?.contrato ?? null,
        contratoHead: canaria.contrato,
        corpo: temSonda
          ? [
              {
                caminho: `${RAIZ_EDGES}/${edge}/index.ts`,
                base:
                  naBase == null || naBase.bloco == null
                    ? null
                    : superficieCanaria(naBase.bloco, defsBase),
                head: superficieCanaria(canaria.bloco, defsHead),
              },
            ]
          : corpoServido,
      });
    }
  }
  return estados;
}

export function main(argv: string[]): number {
  const iBase = argv.indexOf('--base');
  const iHead = argv.indexOf('--head');
  const baseArg = iBase >= 0 ? argv[iBase + 1] : process.env.SONDA_BASE;
  const headRev = iHead >= 0 ? argv[iHead + 1] : null;

  const base = resolverBase(baseArg);
  if (base === null) {
    console.error(
      'canaria-bump-gate: ✗ não consegui determinar a BASE do diff (tentei ' +
        `${process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}, ` : ''}` +
        'origin/main, main).\n' +
        '  No CI: o checkout do job precisa de `fetch-depth: 0`.\n' +
        '  Local: `git fetch origin main`, ou passe `--base <rev>`.\n' +
        '  O gate REPROVA em vez de degradar — não medir não é o mesmo que estar em ordem.',
    );
    return 1;
  }

  const estados = coletarEstadoCanarias(base, headRev);
  const achados = auditarContratos(estados);
  if (achados.length === 0) {
    console.log(
      `canaria-bump-gate: ✓ ${estados.length} canária(s) conferida(s); toda canária cuja ` +
        `superfície mudou bumpou o \`contrato\` (base ${base.slice(0, 9)}).`,
    );
    return 0;
  }

  for (const a of achados) {
    const onde = `${RAIZ_EDGES}/${a.edge}/index.ts`;
    if (a.motivo === 'bloco-indelimitavel') {
      console.error(
        `✗ ${a.edge} (\`${a.contrato}\`): achei a emissão do \`contrato\` em ${onde} e NÃO consegui\n` +
          '  delimitar o bloco da canária (esperado: um `case "<rota>": {` ou `if (…) {` acima dela).\n' +
          '  Sem delimitar o bloco não dá para medir se a superfície mudou — e o gate reprova em vez\n' +
          '  de degradar para verde.',
      );
      continue;
    }
    const explicacao =
      a.regua === 'corpo-servido'
        ? `esta edge NÃO tem \`${ARQ_SONDA}\`, então o \`contrato\` é o ÚNICO marcador de bundle\n` +
          '  que ela tem — e o corpo servido mudou.'
        : 'a superfície que esta canária atesta mudou (o bloco dela, ou uma função que ela exercita).';
    console.error(
      `✗ ${a.edge} [${a.chave}]: ${explicacao}\n` +
        `  O marcador continua \`${a.contrato}\` — o mesmo da base. A canária vai responder o MESMO\n` +
        '  `contrato` tendo esta fatia subido ou não, e um deploy integralmente velho compara\n' +
        '  `expected` velho com código velho e responde `ok:true` mentindo verde.\n' +
        `  Bumpe o \`contrato\` em ${onde} nomeando a fatia que a canária verifica AGORA, e leve\n` +
        '  junto os lugares que fixam o valor: a tabela de `docs/agent/deploy.md` §Canárias, o\n' +
        '  `src/__tests__/edge-money-path-invariants.test.ts` e, se houver, o mapa\n' +
        '  `VERIFICAVEL_POR_CANARIA` de `supabase/functions/_shared/sonda-versao-contrato_test.ts`.',
    );
  }
  console.error(`\ncanaria-bump-gate: ${achados.length} canária(s) sem bump do \`contrato\`.`);
  return 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
