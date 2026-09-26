/**
 * exclusividade.ts — logica PURA da matriz `defeito x gate`.
 * =========================================================
 *
 * ## O buraco que isto tapa
 *
 * O custo de um gate e medido para sempre (segundos no log, a cada PR). O beneficio nao e medido
 * em lugar nenhum. Com um lado da conta visivel e o outro nao, "criar mais um gate" e sempre a
 * escolha barata — e em 3 semanas 15 comandos-gate entraram no `ci.yml`, com o job
 * `gates-e-falsificacao` crescendo 4,4x em 11 dias.
 *
 * A grandeza que faltava e a **contribuicao exclusiva**: dado um corpus de defeitos reais, quais
 * deles SO este gate pega.
 *
 *     gatesQueReprovaram(d) = { g : g fica vermelho com o defeito d aplicado }
 *     exclusivoDe(g)        = { d : gatesQueReprovaram(d) == {g} }
 *
 * ## O que `exclusivoDe(g)` vazio significa — e o que NAO significa
 *
 * Significa **apenas**: *neste corpus de N defeitos, tudo que `g` pega, outro gate tambem pega.*
 *
 * NAO significa "o gate nunca pegou nada". Essa foi a correcao no 1 do parecer do Codex e e a
 * armadilha no 1 do repo: `docs:links` tem dez links quebrados no proprio historico, e mesmo assim
 * nao apareceu numa janela de 80 runs — janela curta nao mede evento raro. Por isso `resumir()`
 * carrega o denominador junto do numero, e nenhuma funcao daqui devolve a string "nao pega nada".
 *
 * ## Fronteira
 *
 * Este arquivo NAO executa gate, nao muta arquivo e nao escreve em disco. Toda a sujeira (aplicar
 * sabotagem, rodar subprocesso, restaurar) vive em `scripts/exclusividade-medir.ts`. E o que faz a
 * derivacao ser testavel em vitest sem rodar um unico gate — e o que permite ao gate barato do CI
 * dar veredito lendo so o JSON.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { parse } from 'yaml';

import { inventarioCI, nomesDeScript, type GateCI } from '../gates-frescura-check';
import { contaComoCorpo, extrairVersao } from '../sonda-versao-bump-gate';

export const MATRIZ_PATH = 'scripts/exclusividade-matriz.json';
export const CI_PATH = '.github/workflows/ci.yml';
export const AUTO_MERGE_PATH = '.github/workflows/auto-merge.yml';
export const CORPUS_DIR = 'scripts/exclusividade.d';
export const SCHEMA_VERSION = 1;

/**
 * O ambiente que o motor impoe a TODO gate (e a receita `regenerar-fingerprints`). Um lugar so: o
 * teste de paridade de `vitest-rpc.test.ts` roda o vitest real sob ESTE objeto, e divergir dele e
 * validar o classificador contra a saida de outro ambiente — o erro que o motivou (2026-09-25).
 *
 * ATENCAO, medido em ambiente limpo (`env -i`): as DUAS variaveis LIGAM a cor do vitest, mesmo com a
 * saida num arquivo. `CI=1` sozinho colore; `FORCE_COLOR=0` sozinho tambem — na biblioteca de cor do
 * vitest a mera PRESENCA de `FORCE_COLOR` forca a cor, valendo `0` ou nao. Quem le a saida de um gate
 * tem de tirar o ANSI antes (`semAnsi`). Nao se troca por `NO_COLOR` aqui: o CI de verdade
 * (`CI=true`) tambem colore, e a promessa do motor e paridade com ele.
 */
export const ENV_DO_MOTOR: Readonly<Record<string, string>> = { CI: '1', FORCE_COLOR: '0' };

/**
 * Os binarios que os scripts do `package.json` chamam do `node_modules/.bin` — a guarda 13 do motor
 * (DEPS-NAO-INSTALADAS) exige que cada um RESPONDA `--version`. Sao os 4 do `Unlisted binaries` do
 * knip no incidente de 2026-09-25 (worktree com o `node_modules` existente e VAZIO). Fixa porque a
 * fonte que a derivaria — o proprio `node_modules` — e justamente o que pode faltar; o teste do motor
 * a confere contra o `package.json` e o `.bin` REAIS, nos dois sentidos.
 */
export const BINARIOS_DAS_DEPS: readonly string[] = ['eslint', 'tsc', 'vite', 'vitest'];

// ---------------------------------------------------------------------------------------------
// Corpus — o formato `.def`
// ---------------------------------------------------------------------------------------------

export interface Defeito {
  id: string;
  /** Arquivo REAL do repo que a sabotagem muta. Raiz sintetica nao serve — ver cabecalho do .def. */
  alvo: string;
  /** Expressao `perl -pe`. Pode conter '|' (alternation) — por isso e sempre o 3o campo, o resto. */
  perl: string;
  arquivo: string;
  linha: number;
  origem: string | null;
  /**
   * Quem o AUTOR acha que pega. Nao ORDENA nem PODA a medicao (a poda e por custo); o motor o
   * executa DEPOIS do laco podado quando a poda o deixou de fora — ver `exclusividade-medir.ts`.
   */
  suspeito: string | null;
  /**
   * O dever de casa do autor DILIGENTE, aplicado depois da sabotagem. Vazio = o autor DESCUIDADO,
   * que e o que o corpus media antes desta coluna existir (e continua medindo por padrao).
   */
  deveres: DeverDeCasa[];
}

// ---------------------------------------------------------------------------------------------
// Dever de casa — o que o autor DILIGENTE faz junto do defeito, por VOCABULARIO FECHADO
// ---------------------------------------------------------------------------------------------

/**
 * ## Por que existe
 *
 * O `.def` aceitava UM alvo por defeito, e o autor que ele descrevia era sempre o DESCUIDADO. Para
 * um gate semantico sobre edge instrumentada, qualquer mudanca no `index.ts` aciona tambem os gates
 * de BYTES (`sonda:bump` exige bump do `VERSAO`; `sonda:fingerprint` exige o mapa regenerado) —
 * entao a exclusividade medida do gate semantico era sempre zero, e o zero media o FORMATO do
 * corpus, nao o gate. O autor que fez o dever de casa (bump + mapa) so e pego pelo gate semantico.
 *
 * ## Por que vocabulario FECHADO, e nao "rode este comando"
 *
 * Um pos-passo de comando livre FABRICA exclusividade: ele pode apagar o script de um concorrente,
 * deixar o alvo intacto, sair 0 e mexer so em arquivo versionado — o estado passa por qualquer
 * guarda de efeito, porque ja existe antes de o primeiro gate rodar (parecer Codex 2026-09-10).
 * Aqui cada receita tem efeito EXATO, conferido pelo motor, e so entra no vocabulario por um
 * criterio verificavel:
 *
 *   **a receita e o conserto que o PROPRIO gate concorrente prescreve na mensagem de falha dele.**
 *
 * E o que separa "o autor fez o dever de casa" de "o autor calou o gate": a neutralizacao e
 * exatamente a que o gate desenhou para aceitar. `prescritaPor` guarda a citacao, e a suite exige
 * que ela continue LITERALMENTE na fonte do gate — se o gate parar de prescrever, a receita cai.
 */
export type NomeReceita = 'bump-versao' | 'regenerar-fingerprints';

export interface DeverDeCasa {
  receita: NomeReceita;
  args: string[];
}

interface DefReceita {
  aridade: number;
  prescritaPor: { gate: string; fonte: string; remedio: string };
  /** Os UNICOS caminhos que a receita pode alterar. O motor confere por snapshot. */
  saidas: (args: string[]) => string[];
  /** A receita so e dever de casa DESTE defeito se o alvo esta no dominio do gate que a prescreve. */
  cabe: (args: string[], alvo: string) => string | null;
}

const EDGE_VALIDA = /^[a-z0-9][a-z0-9-]*$/;

export const RECEITAS: Record<NomeReceita, DefReceita> = {
  'bump-versao': {
    aridade: 1,
    prescritaPor: { gate: 'sonda:bump', fonte: 'scripts/sonda-versao-bump-gate.ts', remedio: 'Bumpe \\`VERSAO\\`' },
    saidas: ([edge]) => [`supabase/functions/${edge}/versao.ts`],
    cabe: ([edge], alvo) => {
      if (!EDGE_VALIDA.test(edge)) return `nome de edge invalido: ${edge}`;
      return contaComoCorpo(alvo, edge) ? null : `o alvo ${alvo} nao e corpo servido da edge ${edge}`;
    },
  },
  'regenerar-fingerprints': {
    aridade: 0,
    prescritaPor: {
      gate: 'sonda:fingerprint',
      fonte: 'scripts/sonda-fingerprint.ts',
      remedio: 'bun run sonda:fingerprint -- --write',
    },
    saidas: () => ['supabase/functions/_shared/sonda-fingerprints.ts'],
    cabe: (_args, alvo) => (alvo.startsWith('supabase/functions/') ? null : `o alvo ${alvo} nao e fonte de edge`),
  },
};

/** O argv que a receita `regenerar-fingerprints` executa — o remedio prescrito, sem shell. */
export const ARGV_REGENERAR_FINGERPRINTS = ['bun', 'run', 'sonda:fingerprint', '--', '--write'];

export const textoDoDever = (dv: DeverDeCasa): string => [dv.receita, ...dv.args].join(' ');

export const saidasDoDever = (dv: DeverDeCasa): string[] => RECEITAS[dv.receita].saidas(dv.args);

function lerDever(texto: string, alvo: string): DeverDeCasa | string {
  const [nome, ...args] = texto.split(/\s+/).filter(Boolean);
  if (!(nome in RECEITAS)) {
    return `receita "${nome}" fora do vocabulario (${Object.keys(RECEITAS).join(', ')}) — comando livre fabricaria exclusividade`;
  }
  const def = RECEITAS[nome as NomeReceita];
  if (args.length !== def.aridade) return `receita ${nome} recebe ${def.aridade} argumento(s), veio ${args.length}`;
  const fora = def.cabe(args, alvo);
  if (fora) return `receita ${nome} fora do dominio do defeito: ${fora}`;
  return { receita: nome as NomeReceita, args };
}

/** Sufixo do bump simulado. Nao tenta parecer versao real: o que importa e o `sonda:bump` le-lo. */
const SUFIXO_BUMP = '-corpus-diligente';

/**
 * A receita `bump-versao`, pura: muda SO o literal da linha `export const VERSAO`. O "bump" e
 * definido pelo leitor do proprio gate (`extrairVersao` do `sonda:bump`) — reescrever a regra aqui
 * criaria uma segunda nocao de "o VERSAO mudou", que e como dois gates passam a discordar calados.
 */
export function aplicarBumpVersao(
  texto: string,
): { ok: true; novo: string; de: string; para: string } | { ok: false; motivo: string } {
  const de = extrairVersao(texto);
  if (de === null) return { ok: false, motivo: 'VERSAO ilegivel para o proprio sonda:bump' };
  const linhas = texto.split('\n');
  const exports = linhas.flatMap((l, i) => (/^\s*export\s+const\s+VERSAO\b/.test(l) ? [i] : []));
  if (exports.length !== 1) {
    return { ok: false, motivo: `${exports.length} linha(s) \`export const VERSAO\` — a receita exige exatamente 1` };
  }
  const para = `${de}${SUFIXO_BUMP}`;
  const antes = linhas[exports[0]];
  const depois = antes.replace(/(=\s*)(["'])(.*?)\2/, (_m, eq: string, q: string) => `${eq}${q}${para}${q}`);
  if (depois === antes) return { ok: false, motivo: 'o literal do VERSAO nao esta na linha do export' };
  linhas[exports[0]] = depois;
  const novo = linhas.join('\n');
  if (extrairVersao(novo) !== para) return { ok: false, motivo: 'o sonda:bump nao leria o VERSAO novo' };
  return { ok: true, novo, de, para };
}

/**
 * Parser do `.def`. Herda do `.mut` o separador '|' e a regra "o 3o campo e o RESTO", porque a
 * expressao perl legitimamente contem '|'. Um split ingenuo em 3 partes truncaria a regex no meio
 * e a sabotagem viraria uma nao-aplicacao silenciosa — que o motor classifica como INVALIDA, mas
 * so depois de ter gasto a execucao de todos os gates.
 *
 * `@origem`/`@suspeito` sao PEGAJOSOS (valem ate serem redefinidos); `@dever-de-casa` vale SO para
 * a proxima linha de defeito. A assimetria e de proposito: um dever de casa herdado por engano
 * neutralizaria os gates de bytes num defeito que nao o pediu. Por isso tambem ele e ESTRITO onde
 * o resto do parser e leniente — receita invalida ou pendurada LANCA, em vez de sumir calada.
 */
export function parseDefeitos(texto: string, arquivo: string): Defeito[] {
  const saida: Defeito[] = [];
  let origem: string | null = null;
  let suspeito: string | null = null;
  let pendentes: { texto: string; linha: number }[] = [];

  texto.split('\n').forEach((bruta, i) => {
    const linha = bruta.trim();
    if (!linha) return;
    if (linha.startsWith('#')) {
      const mo = linha.match(/@origem:\s*(.+)$/);
      if (mo) origem = mo[1].trim();
      const ms = linha.match(/@suspeito:\s*(.+)$/);
      if (ms) suspeito = ms[1].trim();
      const md = linha.match(/@dever-de-casa:\s*(.+)$/);
      if (md) pendentes.push({ texto: md[1].trim(), linha: i + 1 });
      return;
    }
    const corte1 = linha.indexOf('|');
    if (corte1 < 0) return;
    const corte2 = linha.indexOf('|', corte1 + 1);
    if (corte2 < 0) return;
    const id = linha.slice(0, corte1).trim();
    const alvo = linha.slice(corte1 + 1, corte2).trim();
    const perl = linha.slice(corte2 + 1).trim();
    if (!id || !alvo || !perl) return;
    const deveres = pendentes.map((p) => {
      const dv = lerDever(p.texto, alvo);
      if (typeof dv === 'string') throw new Error(`DEVER-DE-CASA-INVALIDO ${arquivo}:${p.linha} (${id}): ${dv}`);
      return dv;
    });
    pendentes = [];
    saida.push({ id, alvo, perl, arquivo, linha: i + 1, origem, suspeito, deveres });
  });

  if (pendentes.length) {
    throw new Error(
      `DEVER-DE-CASA-PENDURADO ${arquivo}:${pendentes[0].linha}: @dever-de-casa sem linha de defeito depois — ` +
        'ele vale SO para a proxima linha, e aqui nao ha nenhuma.',
    );
  }
  return saida;
}

// ---------------------------------------------------------------------------------------------
// Quais gates existem, e quais de fato BLOQUEIAM um PR
// ---------------------------------------------------------------------------------------------

export interface GateAlvo extends GateCI {
  /** True so se o job dele e o `validate` ou alcancavel a partir dele (fecho de `needs`). */
  bloqueiaPR: boolean;
}

/**
 * O unico job que o auto-merge exige por nome (`.github/workflows/auto-merge.yml`). Sem `export`
 * de proposito: os testes casam o literal `'validate'`, nao este simbolo — asserir contra a
 * constante faria a assercao se mover junto com o codigo, que e teste que nao pode falhar.
 */
const JOB_RAIZ = 'validate';

/**
 * Fecho transitivo de `validate.needs`, **com o proprio `validate` dentro**. Existe porque
 * `inventarioCI` filtra `continue-on-error` no **step** e isso nao ve a outra forma de ser
 * informativo: um JOB inteiro fora de `validate.needs`.
 *
 * E exatamente o caso do job `mutation-check` do `ci.yml`, deliberadamente informativo e abrindo
 * Issue desde o #2344 — que `inventarioCI` hoje lista junto dos bloqueantes. Derivar do grafo, em
 * vez de manter uma lista de excecoes, e o que impede este censo de envelhecer como envelheceu o
 * censo datado de 15 nomes que originou o `gates:frescura`.
 *
 * ## Por que a RAIZ entra no fecho (o #2376 a deixou de fora)
 *
 * `needs` aponta para tras — ninguem aponta para o `validate` —, entao um fecho que parte de
 * `validate.needs` exclui a raiz por CONSTRUCAO. E a raiz e justamente o unico job que o
 * auto-merge exige por nome: se ele fica vermelho, o PR nao mergeia. O efeito era um ponto cego
 * simetrico, o pior tipo: um step dentro do `validate` sumia das DUAS contas ao mesmo tempo — nem
 * `gatesCandidatos` o marcava `bloqueiaPR` (logo, nunca cobrado pela prova de exclusividade), nem
 * `bloqueantesOpacos` o listava. Hoje o `validate` so hospeda o agregador; "hoje nao esconde nada"
 * e exatamente o que valia para o `provas-sql` ate o #2364 por la acrescentar um gate em shell.
 *
 * A raiz so entra se EXISTIR no arquivo. Somar um nome que o `ci.yml` nao tem seria fabricar
 * presenca — e um `ci.yml` sem `validate` deve continuar devolvendo conjunto VAZIO, que e a forma
 * honesta de dizer "nao encontrei o required check aqui".
 */
export function jobsBloqueantes(fonteCI: string): Set<string> {
  const doc = parse(fonteCI) as { jobs?: Record<string, { needs?: unknown }> };
  const jobs = doc.jobs ?? {};
  const needsDe = (j: string): string[] => {
    const n = jobs[j]?.needs;
    if (typeof n === 'string') return [n];
    if (Array.isArray(n)) return n.filter((x): x is string => typeof x === 'string');
    return [];
  };
  const vistos = new Set<string>();
  const fila = JOB_RAIZ in jobs ? [JOB_RAIZ] : [];
  while (fila.length) {
    const j = fila.pop()!;
    if (vistos.has(j)) continue;
    vistos.add(j);
    fila.push(...needsDe(j));
  }
  return vistos;
}

// ---------------------------------------------------------------------------------------------
// Guarda anti-vacuo da RAIZ — o `JOB_RAIZ` e um literal, e literal envelhece calado
// ---------------------------------------------------------------------------------------------

export interface AncoraQuebrada {
  codigo: 'RAIZ_AUSENTE_NO_CI' | 'FECHO_BLOQUEANTE_VAZIO' | 'ANCORA_AUTO_MERGE_PERDIDA';
  motivo: string;
}

/**
 * Confere que o nome em `JOB_RAIZ` ainda e o required check de verdade. Nao devolve gate nenhum:
 * devolve os motivos pelos quais a maquina de exclusividade **nao pode afirmar nada hoje**.
 *
 * ## O vacuo que isto fecha
 *
 * `jobsBloqueantes` parte de um LITERAL e ninguem conferia que ele existe. Renomeie o job
 * `validate` no `ci.yml` (ou mude o required check de nome) e a cascata inteira desliga em
 * silencio, sem uma linha vermelha:
 *
 *   fecho VAZIO -> `gatesCandidatos` marca TODOS com `bloqueiaPR: false` -> `avaliar`, que filtra
 *   por `bloqueiaPR`, nao cobra NINGUEM -> `bloqueantesOpacos` nao lista nada -> o gate sai 0
 *   anunciando "0 gate(s) bloqueante(s)".
 *
 * Zero lido como cobertura total e o mesmo veneno do guard de DENOMINADOR do agregador
 * (`ci.yml`: "li $total job(s), esperava $esperados — o agregador nao pode afirmar nada") e da
 * guarda anti-vacuo do gate de indice: `ausente != zero`, aplicado ao proprio censo.
 *
 * ## Por que cruzar com o `auto-merge.yml`, e o que esse cruzamento NAO promete
 *
 * A verdade sobre qual check e required nao mora no repo — mora na branch protection do GitHub
 * (`gh api repos/:owner/:repo/branches/main/protection --jq .required_status_checks.contexts`,
 * que em 2026-09-08 devolveu exatamente `["validate"]`). Consultar isso aqui exigiria rede e um
 * token com `administration: read`, que o `GITHUB_TOKEN` do CI nao tem — e um gate barato que
 * depende de rede vira um gate que degrada.
 *
 * Entao o cruzamento e de CONCORDANCIA, nao de derivacao: o `auto-merge.yml` cita o nome do
 * required check (hoje so em prosa, no cabecalho — o `run:` dele e `gh pr merge --auto`, que nao
 * nomeia check nenhum), e este guard exige que as TRES pontas digam a mesma coisa: o literal
 * daqui, o nome do job no `ci.yml` e a citacao no `auto-merge.yml`. Renomear passa a custar tres
 * edicoes coordenadas em vez de uma silenciosa.
 *
 * Ler PROSA de proposito e a excecao que confirma a regra do stripper compartilhado (gate textual
 * nunca mede comentario): aqui o comentario nao e ruido em volta da medicao, e a unica ancora
 * textual que o repo tem para o nome. O limite fica dito em voz alta: se alguem trocar o required
 * check **na branch protection** sem tocar em arquivo nenhum, este guard segue verde e mentiroso.
 * Esse eixo so se prova com `gh api`, e e trabalho de humano.
 */
export function conferirAncoraDaRaiz(fonteCI: string, fonteAutoMerge: string | null): AncoraQuebrada[] {
  const problemas: AncoraQuebrada[] = [];

  const doc = parse(fonteCI) as { jobs?: Record<string, unknown> };
  const nomesDeJob = Object.keys(doc.jobs ?? {});
  if (!nomesDeJob.includes(JOB_RAIZ)) {
    problemas.push({
      codigo: 'RAIZ_AUSENTE_NO_CI',
      motivo:
        `o required check \`${JOB_RAIZ}\` NAO esta entre os ${nomesDeJob.length} job(s) de ${CI_PATH} ` +
        `[${nomesDeJob.join(', ') || 'nenhum'}] — o job foi renomeado/removido e o literal ficou stale. ` +
        `Sem a raiz o fecho de bloqueantes vem vazio e esta maquina aprovaria TODO gate por ausencia de dado.`,
    });
  }

  // Eixo proprio, e nao corolario do anterior: hoje `fecho vazio` <=> `raiz ausente`, mas quem
  // decide isso e a implementacao de `jobsBloqueantes`. Se ela mudar de forma e passar a devolver
  // vazio por outro caminho, o efeito para o gate e IDENTICO — logo a assercao e sobre o efeito.
  const fecho = jobsBloqueantes(fonteCI);
  if (fecho.size === 0) {
    problemas.push({
      codigo: 'FECHO_BLOQUEANTE_VAZIO',
      motivo:
        `\`jobsBloqueantes\` devolveu conjunto VAZIO para ${CI_PATH} — nenhum job bloqueia o PR segundo esta ` +
        `leitura. Isso nunca e verdade num repo com CI: e a assinatura de que o required check nao foi ` +
        `encontrado. NAO leia como "nenhum gate bloqueia".`,
    });
  }

  // Marcado entre crases porque e assim que o `auto-merge.yml` cita o check no cabecalho; casar a
  // palavra solta acharia `validate` dentro de `validation`/`validate-schema` de um step futuro.
  const citado = `\`${JOB_RAIZ}\``;
  if (fonteAutoMerge === null) {
    problemas.push({
      codigo: 'ANCORA_AUTO_MERGE_PERDIDA',
      motivo:
        `${AUTO_MERGE_PATH} nao existe — sumiu a segunda ponta que nomeia o required check, e com ela a ` +
        `unica forma de este guard notar que \`${JOB_RAIZ}\` deixou de ser o check exigido.`,
    });
  } else if (!fonteAutoMerge.includes(citado)) {
    problemas.push({
      codigo: 'ANCORA_AUTO_MERGE_PERDIDA',
      motivo:
        `${AUTO_MERGE_PATH} nao cita mais ${citado} — as duas pontas do repo discordam sobre o nome do ` +
        `required check. Confira a verdade com \`gh api repos/:owner/:repo/branches/main/protection ` +
        `--jq .required_status_checks.contexts\` e alinhe o literal \`JOB_RAIZ\`, o job do ${CI_PATH} e a ` +
        `citacao do ${AUTO_MERGE_PATH}.`,
    });
  }

  return problemas;
}

export function gatesCandidatos(fonteCI: string): GateAlvo[] {
  const bloq = jobsBloqueantes(fonteCI);
  return inventarioCI(fonteCI).map((g) => ({ ...g, bloqueiaPR: bloq.has(g.job) }));
}

// ---------------------------------------------------------------------------------------------
// Paridade de invocacao — o motor roda O QUE O CI RODA
// ---------------------------------------------------------------------------------------------

export interface Invocacao {
  argv: string[];
  env: Record<string, string>;
}

export type ResultadoInvocacao = ({ ok: true } & Invocacao) | { ok: false; motivo: string };

/** Token que o motor reproduz sem shell. Aspas, `$`, glob, `~`, redirecionamento: fora. */
const TOKEN_SIMPLES = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * A invocacao EXATA que o CI faz de um gate: argv + `env:` literal de workflow/job/step.
 *
 * ## O buraco que isto fecha (medido 2026-09-10)
 *
 * O motor rodava `bun run <nome>` para todo gate, e o CI nao roda isso para todos:
 *
 *   - `sonda:cron-prova`: o CI roda `-- --gate`. Sem ele, `sonda-cron-prova.ts` e o modo BACKFILL,
 *     que termina em `gravarManifesto` — regravou `_shared/sonda-cron-prova.json` (+411/-264) e
 *     todo gate seguinte do baseline mediu arvore suja (`test` vermelho, motor abortado).
 *   - `tsc`: o CI roda `bunx tsc --noEmit -p tsconfig.app.json`. Sem script `tsc` no package.json,
 *     `bun run tsc` roda o binario contra o tsconfig RAIZ (`files: []`) — NO-OP, rc=0 em 640ms. O
 *     gate estava na matriz como "medido" sem nunca poder reprovar.
 *   - `build`: o CI passa `NODE_ENV: production`; o motor nao passava.
 *
 * E a licao de `docs/historico/falsificacao-sem-linha-de-base.md` um andar acima: a medicao que
 * roda OUTRA invocacao nao mede o gate, por mais que o nome bata.
 *
 * ## Por que o `run:` inteiro tem de SER o comando simples
 *
 * Recortar o comando de dentro de um step composto perderia o que o compoe: `cd sub; bun run g`
 * perde o diretorio, `bun run g || true` perde o fato de o step nunca reprovar. O status do step e
 * do step inteiro. Entao so um `run:` que e exatamente um comando simples e medivel; o resto e
 * NAO-REPRODUZIVEL e o motor aborta nomeando o gate — nunca adivinha. `if: pull_request` e
 * ignorado de proposito: o motor simula um PR.
 *
 * Mesma fonte e mesmo filtro de `inventarioCI` (`nomesDeScript`, sem `continue-on-error`, so jobs
 * bloqueantes), mas SEM a deduplicacao dele: o mesmo gate invocado de dois jeitos e AMBIGUO.
 */
export function invocacaoDoCI(fonteCI: string, nome: string): ResultadoInvocacao {
  type Passo = { name?: string; run?: unknown; env?: unknown; 'working-directory'?: unknown; 'continue-on-error'?: unknown };
  type Job = { steps?: Passo[]; env?: unknown; defaults?: { run?: { 'working-directory'?: unknown } } };
  const doc = parse(fonteCI) as { env?: unknown; defaults?: Job['defaults']; jobs?: Record<string, Job> };
  const bloq = jobsBloqueantes(fonteCI);

  const envLiteral = (bruto: unknown, onde: string): Record<string, string> | string => {
    if (bruto === undefined || bruto === null) return {};
    if (typeof bruto !== 'object') return `env de ${onde} nao e mapa`;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(bruto as Record<string, unknown>)) {
      if (!['string', 'number', 'boolean'].includes(typeof v) || String(v).includes('${{')) {
        return `env ${k} de ${onde} depende do contexto do GitHub (${JSON.stringify(v)})`;
      }
      out[k] = String(v);
    }
    return out;
  };

  const vistas = new Map<string, Invocacao>();
  for (const [job, corpo] of Object.entries(doc.jobs ?? {})) {
    if (!bloq.has(job)) continue;
    for (const st of corpo?.steps ?? []) {
      if (typeof st.run !== 'string' || st['continue-on-error'] === true) continue;
      if (!nomesDeScript(st.run).has(nome)) continue;
      const onde = `${job} / ${st.name ?? '(sem nome)'}`;
      const nao = (porque: string): ResultadoInvocacao => ({ ok: false, motivo: `NAO-REPRODUZIVEL ${nome} em "${onde}": ${porque}` });

      if (st['working-directory'] ?? corpo.defaults?.run?.['working-directory'] ?? doc.defaults?.run?.['working-directory']) {
        return nao('working-directory muda o que roda');
      }
      const run = st.run.trim();
      const argv = run.split(/\s+/);
      if (run.includes('\n') || !argv.every((t) => TOKEN_SIMPLES.test(t))) {
        return nao(`o run: nao e UM comando simples (\`${run.split('\n')[0].slice(0, 80)}\`)`);
      }
      const forma =
        (argv[0] === 'bun' || argv[0] === 'bunx') && argv[1] === 'run'
          ? argv[2]
          : argv[0] === 'bunx' || argv[0] === 'bun'
            ? argv[1]
            : undefined;
      if (forma !== nome) return nao(`o comando simples nao invoca ${nome} na posicao de script (\`${run}\`)`);

      const envs = [envLiteral(doc.env, 'workflow'), envLiteral(corpo.env, `job ${job}`), envLiteral(st.env, onde)];
      const erroEnv = envs.find((e): e is string => typeof e === 'string');
      if (erroEnv) return nao(erroEnv);
      const env = Object.assign({}, ...(envs as Record<string, string>[])) as Record<string, string>;
      const inv = { argv, env };
      vistas.set(assinaturaInvocacao(inv), inv);
    }
  }

  if (vistas.size === 0) return { ok: false, motivo: `SEM-INVOCACAO ${nome}: nenhum step bloqueante do ci.yml o invoca` };
  if (vistas.size > 1) {
    return { ok: false, motivo: `AMBIGUA ${nome}: invocado de ${vistas.size} jeitos — ${[...vistas.keys()].join(' | ')}` };
  }
  const [inv] = vistas.values();
  return { ok: true, ...inv };
}

/** Forma canonica de uma invocacao — e o que cada execucao grava e o que a derivacao compara. */
export function assinaturaInvocacao(inv: Invocacao): string {
  const env = Object.keys(inv.env)
    .sort()
    .map((k) => `${k}=${inv.env[k]}`);
  return [...(env.length ? [`env{${env.join(',')}}`] : []), ...inv.argv].join(' ');
}

/**
 * O que o motor rodava ANTES da paridade: `bun run <nome>`, sem env. Execucao gravada sem o campo
 * `invocacao` foi, por construcao, isto — e so vale para gate que o CI de fato invoca assim.
 */
const assinaturaLegada = (nome: string): string => assinaturaInvocacao({ argv: ['bun', 'run', nome], env: {} });

export interface StepOpaco {
  job: string;
  step: string;
  /** 1a linha COM CARNE do `run:`, truncada — o que ele executa, ja que nome ele nao tem. */
  comando: string;
}

/**
 * Steps que BLOQUEIAM o PR e que `gatesCandidatos` nao consegue nomear, porque nao invocam script
 * do `package.json`. E o COMPLEMENTO exato do censo: mesma fonte, mesmo filtro de
 * `continue-on-error`, mesmo `nomesDeScript` — o que sobra aqui e precisamente o que faltou la.
 *
 * ## Por que isto existe (a lacuna era medida, nao hipotetica)
 *
 * O #2364 acrescentou `run: bash db/roda-nucleo-ci.sh` ao `ci.yml`: um gate bloqueante REAL, em
 * shell puro. `gatesCandidatos` nao o ve — e o cabecalho seguia anunciando "28 gate(s)
 * bloqueante(s)", numero que le como cobertura TOTAL. Ou seja, a maquina que cobra prova de
 * exclusividade de todo gate novo tinha, ela propria, um gate novo isento em silencio.
 *
 * Contar em voz alta nao fecha a lacuna — o motor de medicao invoca `bun run <nome>`, e sem nome
 * de script nao ha o que invocar. Fecha o SILENCIO, que e o que fazia o numero mentir. Mesmo
 * remedio, e pelo mesmo motivo, do `bloqueantesSemScript` do `gates:frescura`.
 *
 * ## Onde este contador e MAIS estreito que o do frescura, de proposito
 *
 * O do frescura conta todo step sem script; este so conta os de job alcancavel a partir de
 * `validate.needs`. `authz-sentinela` aparece la e nao aqui — e certo nos dois: la o eixo e
 * "reprova alguma coisa", aqui e "reprova o PR". Este arquivo tem o grafo de `needs`; o frescura
 * nao.
 *
 * ## O agregador do `validate` aparece aqui — e isso e o certo, nao ruido
 *
 * Desde que `jobsBloqueantes` passou a incluir a raiz, o step "Todos os jobs passaram?" cai neste
 * contador. Ele nao e um no-op que soma resultados: tem logica PROPRIA, ja falha-aberta uma vez —
 * o guard de DENOMINADOR (`total -ne esperados`, contra o jq que devolve nada) e o guard NOMINAL
 * de `provas-sql`, acrescentado pelo parecer do Codex de 2026-09-07 sob a frase "cinco jobs
 * quaisquer nao provam que SQL entrou no contrato". Um step assim e a categoria exata que este
 * contador existe para manter visivel. Filtra-lo por nome reabriria o silencio na unica linha que
 * o fecha, e devolveria a lista de excecoes que `jobsBloqueantes` se recusa a manter.
 */
/**
 * A 1a linha do `run:` que de fato EXECUTA algo. Pula vazio, comentario e prologo (`set -euo
 * pipefail`, `shopt`, `export`), que sao 100% dos primeiros-linhas dos steps opacos de hoje: sem
 * este filtro o contador imprimia `$ set -euo pipefail` tres vezes, que e presenca sem informacao
 * — a mesma doenca, um andar abaixo, do numero que se queria consertar.
 */
export function primeiraLinhaComCarne(run: string, limite = 60): string {
  const carne = run
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !/^(?:set|shopt|export|umask)\s/.test(l));
  const escolhida = carne ?? run.split('\n').find((l) => l.trim())?.trim() ?? '';
  return escolhida.length > limite ? `${escolhida.slice(0, limite - 3)}...` : escolhida;
}

export function bloqueantesOpacos(fonteCI: string): StepOpaco[] {
  const doc = parse(fonteCI) as { jobs?: Record<string, { steps?: unknown[] }> };
  const bloq = jobsBloqueantes(fonteCI);
  const saida: StepOpaco[] = [];

  for (const [job, corpo] of Object.entries(doc.jobs ?? {})) {
    if (!bloq.has(job)) continue;
    for (const bruto of corpo?.steps ?? []) {
      const st = bruto as { name?: string; run?: unknown; 'continue-on-error'?: unknown };
      if (typeof st.run !== 'string' || st['continue-on-error'] === true) continue;
      if (nomesDeScript(st.run).size > 0) continue;
      saida.push({ job, step: st.name ?? '(sem nome)', comando: primeiraLinhaComCarne(st.run) });
    }
  }
  return saida;
}

// ---------------------------------------------------------------------------------------------
// Fingerprints — o que faz uma linha da matriz APODRECER
// ---------------------------------------------------------------------------------------------

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * O dever de casa entra no hash SO quando existe: defeito sem ele mantem o fingerprint de antes, e
 * as linhas ja medidas da matriz nao apodrecem por uma coluna que elas nunca tiveram.
 */
export const fingerprintDefeito = (d: Defeito): string =>
  sha(d.deveres?.length ? `${d.alvo} ${d.perl}\n${d.deveres.map(textoDoDever).join('\n')}` : `${d.alvo} ${d.perl}`);

export interface FonteDoGate {
  comando: string;
  arquivos: string[];
  /** False quando nenhum arquivo do comando pode ser resolvido no disco. */
  resolvida: boolean;
}

/**
 * Arquivos que compoem a fonte de um gate. Resolve o que e literal no comando do `package.json`
 * (`bun scripts/foo.ts`) e expande o laco `for t in a b c; do bash scripts/test-$t.sh` que
 * `test:hooks` e `test:falsificacao` usam — sem essa expansao os dois maiores gates do repo
 * ficariam com fonte vazia.
 *
 * Quando nada resolve, `resolvida: false` — e o eixo "apodreceu?" fica INDISPONIVEL para esse
 * gate, dito em voz alta no relatorio. Alegar frescor que nao se consegue verificar seria a mesma
 * falha aberta de sempre: silencio lido como aprovacao.
 */
export function fonteDoGate(nome: string, scripts: Record<string, string>, raiz = '.'): FonteDoGate {
  const comando = scripts[nome] ?? '';
  const arquivos = new Set<string>();

  // 1) laco `for X in a b c; do ... prefixo-$X-sufixo.sh` -> materializa cada item da lista.
  for (const laco of comando.matchAll(/for\s+(\w+)\s+in\s+([^;]+);\s*do\s+([^;]+)/g)) {
    const [, varNome, listaBruta, corpo] = laco;
    const itens = listaBruta.trim().split(/\s+/);
    const molde = corpo.match(new RegExp(`([\\w./-]*\\$(?:\\{${varNome}\\}|${varNome})[\\w./-]*)`));
    if (!molde) continue;
    for (const item of itens) {
      const p = molde[1].replace(new RegExp(`\\$\\{?${varNome}\\}?`), item);
      if (existsSync(`${raiz}/${p}`)) arquivos.add(p);
    }
  }

  // 2) caminhos literais.
  for (const m of comando.matchAll(/(?:^|[\s'"])([\w.-]+(?:\/[\w.$-]+)+\.(?:ts|sh|mjs|js))/g)) {
    if (m[1].includes('$')) continue;
    if (existsSync(`${raiz}/${m[1]}`)) arquivos.add(m[1]);
  }

  return { comando, arquivos: [...arquivos].sort(), resolvida: arquivos.size > 0 };
}

export function fingerprintGate(f: FonteDoGate, raiz = '.'): string {
  const corpos = f.arquivos.map((a) => {
    try {
      return `${a} ${sha(readFileSync(`${raiz}/${a}`, 'utf8'))}`;
    } catch {
      return `${a} ILEGIVEL`;
    }
  });
  return sha([f.comando, ...corpos].join('\n'));
}

// ---------------------------------------------------------------------------------------------
// A matriz
// ---------------------------------------------------------------------------------------------

export interface ExecucaoGate {
  gate: string;
  reprovou: boolean;
  ms: number;
  fingerprint: string;
  fonteResolvida: boolean;
  /**
   * `assinaturaInvocacao` do que o motor EXECUTOU. Ausente = execucao anterior a paridade de
   * invocacao, que por construcao foi `bun run <gate>` (`assinaturaLegada`). A derivacao so aceita
   * a execucao se ela bate com a invocacao do CI de hoje.
   */
  invocacao?: string;
}

export interface LinhaMatriz {
  defeito: string;
  defeitoFingerprint: string;
  alvo: string;
  suspeito: string | null;
  origem: string | null;
  /** O dever de casa aplicado (texto das receitas). Ausente = autor descuidado. */
  deveres?: string[];
  /** Caminhos que o dever de casa alterou, alem do alvo — para auditar o efeito, nao so a receita. */
  tocados?: string[];
  execucoes: ExecucaoGate[];
  /**
   * True quando a medicao parou no 2o vermelho. Os gates nao rodados ficam DESCONHECIDOS —
   * jamais "nao reprovaram". Para exclusividade isso e seguro (>=2 vermelhos ja refuta), e e por
   * isso que a poda e honesta; mas afirmar o conjunto completo a partir de uma linha podada
   * seria fabricar ausencia, entao `derivar()` se recusa a fazer isso.
   */
  parouCedo: boolean;
  invalido: string | null;
  /**
   * Gates cuja execucao nesta linha e ANTERIOR a uma rodada que os excluiu por vermelho no baseline
   * (`exclusividadeVermelhaSoPorGateNovo`) e re-mediu os outros. A celula continua EXECUCAO (`rodou`):
   * descarta-la devolveria o GATE_NOVO do proprio `exclusividade` numa rodada do corpus inteiro, sem
   * saida. Mas NAO fecha a completude — e de outro regime, e a linha nao certifica ninguem ate uma
   * rodada re-executa-los. Ausente = nenhuma. Parecer Codex 2026-09-14.
   */
  defasados?: string[];
}

export interface BaselineGate {
  gate: string;
  verde: boolean;
  ms: number;
}

export interface Matriz {
  schemaVersion: number;
  medidoEm: string;
  sourceHead: string;
  /**
   * Gates que ja existiam quando a maquina nasceu e ainda nao foram medidos. E DIVIDA DECLARADA,
   * nao isencao: um gate NOVO nao entra aqui sozinho, e acrescentar um nome a lista aparece no
   * diff do PR — que e o ponto, ja que o custo de um gate novo e justamente o que se quer visivel.
   */
  dispensados: { gate: string; desde: string; motivo: string }[];
  baseline: BaselineGate[];
  linhas: LinhaMatriz[];
}

/** Por que a matriz NAO pode ser lida. Cada codigo vira REPROVA com o proprio nome. */
interface RecusaDaMatriz {
  codigo: 'MATRIZ_AUSENTE' | 'MATRIZ_SCHEMA_INCOMPATIVEL' | 'MATRIZ_MALFORMADA';
  motivo: string;
}

/** O que sai de `lerMatriz`: a matriz no schema de hoje, ou a recusa com o porque. */
export type LeituraDaMatriz = { ok: true; matriz: Matriz } | ({ ok: false } & RecusaDaMatriz);

// A forma do schema de hoje, campo a campo — o que `derivar`, `avaliar` e `fundirLinhas` leem.
// `?` e opcional POR DESENHO (`invocacao` ausente = execucao anterior a paridade de invocacao).
type Tipo = 'texto' | 'numero' | 'booleano' | 'texto|null' | 'lista de texto';
type Forma = Record<string, Tipo | `${Tipo}?`>;

const CONFERE: Record<Tipo, (v: unknown) => boolean> = {
  texto: (v) => typeof v === 'string',
  numero: (v) => typeof v === 'number' && Number.isFinite(v),
  booleano: (v) => typeof v === 'boolean',
  'texto|null': (v) => v === null || typeof v === 'string',
  'lista de texto': (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
};
const FORMA_RAIZ: Forma = { medidoEm: 'texto', sourceHead: 'texto' };
const FORMA_DISPENSADO: Forma = { gate: 'texto', desde: 'texto', motivo: 'texto' };
const FORMA_BASELINE: Forma = { gate: 'texto', verde: 'booleano', ms: 'numero' };
const FORMA_LINHA: Forma = {
  defeito: 'texto',
  defeitoFingerprint: 'texto',
  alvo: 'texto',
  suspeito: 'texto|null',
  origem: 'texto|null',
  deveres: 'lista de texto?',
  tocados: 'lista de texto?',
  parouCedo: 'booleano',
  invalido: 'texto|null',
  defasados: 'lista de texto?',
};
const FORMA_EXECUCAO: Forma = {
  gate: 'texto',
  reprovou: 'booleano',
  ms: 'numero',
  fingerprint: 'texto',
  fonteResolvida: 'booleano',
  invocacao: 'texto?',
};

const ehObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const tem = (o: Record<string, unknown>, campo: string): boolean => Object.prototype.hasOwnProperty.call(o, campo);
const NOME_DO_TIPO: Record<string, string> = { string: 'texto', number: 'numero', boolean: 'booleano', object: 'objeto' };
/** O TIPO do que veio, em ASCII — nunca o valor, que traria acento do arquivo para a mensagem. */
const tipoDe = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'lista' : (NOME_DO_TIPO[typeof v] ?? typeof v));

/** O primeiro campo fora da forma, com o caminho inteiro (`linhas[3].execucoes[0].reprovou`), ou `null`. */
function foraDaForma(v: unknown, forma: Forma, onde: string): string | null {
  if (!ehObjeto(v)) return `${onde} deveria ser objeto (veio ${tipoDe(v)})`;
  for (const [campo, spec] of Object.entries(forma)) {
    const opcional = spec.endsWith('?');
    const tipo = (opcional ? spec.slice(0, -1) : spec) as Tipo;
    const caminho = onde ? `${onde}.${campo}` : campo;
    if (!tem(v, campo)) {
      if (opcional) continue;
      return `${caminho} ausente`;
    }
    if (!CONFERE[tipo](v[campo])) return `${caminho} deveria ser ${tipo} (veio ${tipoDe(v[campo])})`;
  }
  return null;
}

function listaForaDaForma(v: unknown, onde: string, item: (x: unknown, onde: string) => string | null): string | null {
  if (v === undefined) return `${onde} ausente`;
  if (!Array.isArray(v)) return `${onde} deveria ser lista (veio ${tipoDe(v)})`;
  for (let i = 0; i < v.length; i++) {
    const p = item(v[i], `${onde}[${i}]`);
    if (p !== null) return p;
  }
  return null;
}

function matrizForaDaForma(doc: Record<string, unknown>): string | null {
  return (
    foraDaForma(doc, FORMA_RAIZ, '') ??
    listaForaDaForma(doc.dispensados, 'dispensados', (x, onde) => foraDaForma(x, FORMA_DISPENSADO, onde)) ??
    listaForaDaForma(doc.baseline, 'baseline', (x, onde) => foraDaForma(x, FORMA_BASELINE, onde)) ??
    listaForaDaForma(
      doc.linhas,
      'linhas',
      (x, onde) =>
        foraDaForma(x, FORMA_LINHA, onde) ??
        listaForaDaForma(ehObjeto(x) ? x.execucoes : undefined, `${onde}.execucoes`, (e, ondeE) => foraDaForma(e, FORMA_EXECUCAO, ondeE)),
    )
  );
}

const ehMatriz = (doc: Record<string, unknown>): doc is Record<string, unknown> & Matriz =>
  doc.schemaVersion === SCHEMA_VERSION && matrizForaDaForma(doc) === null;

/**
 * A UNICA porta de bytes para `Matriz` — o gate e o motor leem por aqui. `null` = o arquivo nao existe.
 *
 * ## Por que ela confere a versao E a forma (2026-09-25)
 *
 * `SCHEMA_VERSION` era GRAVADO pelo motor e nunca conferido: `JSON.parse(...) as Matriz` lia uma matriz
 * de outro schema como a de hoje. Campo fora do lugar chegava `undefined` no meio do veredito — TypeError
 * (exit 2, "erro do proprio gate") ou, pior, `reprovou` ausente lido como "nao reprovou", e o veredito
 * saia calculado sobre dado alheio. E o motor, que FUNDE a anterior e a regrava com a versao de hoje, a
 * "migrava" calado. Aqui cada falha e uma RECUSA com codigo: o gate a imprime como REPROVA, e o motor
 * aborta antes do baseline (guarda 14).
 *
 * A ordem importa: versao ANTES da forma. Matriz de outro schema tem, legitimamente, outra forma — e
 * chama-la de MALFORMADA mandaria o operador consertar o arquivo em vez de re-medir.
 *
 * Toda mensagem e ASCII imprimivel (sem acento, sem travessao): e o que a suite e o operador casam sem
 * `-i`, em `LC_ALL=C` e em `pt_BR.UTF-8`. Por isso ela nomeia o TIPO do que veio, nunca o valor.
 */
export function lerMatriz(texto: string | null): LeituraDaMatriz {
  const remedir = 're-meca com `bun run exclusividade:medir`';
  if (texto === null) return { ok: false, codigo: 'MATRIZ_AUSENTE', motivo: `${MATRIZ_PATH} ausente - ${remedir}.` };
  let doc: unknown;
  try {
    doc = JSON.parse(texto);
  } catch {
    // Ilegivel e indistinguivel de ausente para efeito de evidencia — os dois sao fail-closed.
    return { ok: false, codigo: 'MATRIZ_AUSENTE', motivo: `${MATRIZ_PATH} ilegivel (JSON invalido) - ${remedir}.` };
  }
  if (!ehObjeto(doc)) {
    return { ok: false, codigo: 'MATRIZ_MALFORMADA', motivo: `${MATRIZ_PATH} deveria ser um objeto JSON (veio ${tipoDe(doc)}) - restaure do git.` };
  }
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    const v = doc.schemaVersion;
    const lida = !tem(doc, 'schemaVersion')
      ? 'schemaVersion ausente'
      : typeof v === 'number'
        ? `schemaVersion ${v}`
        : `schemaVersion nao numerico (veio ${tipoDe(v)})`;
    return {
      ok: false,
      codigo: 'MATRIZ_SCHEMA_INCOMPATIVEL',
      motivo:
        `${MATRIZ_PATH} tem ${lida}; este codigo le schemaVersion ${SCHEMA_VERSION}. Formato incompativel: ` +
        `${remedir} na versao do codigo que vai ler a matriz - nunca edite o numero a mao.`,
    };
  }
  if (!ehMatriz(doc)) {
    return {
      ok: false,
      codigo: 'MATRIZ_MALFORMADA',
      motivo:
        `${MATRIZ_PATH} fora da forma do schema ${SCHEMA_VERSION}: ${matrizForaDaForma(doc)}. Conflito de merge ` +
        `mal resolvido ou edicao a mao? Restaure do git, ou ${remedir}.`,
    };
  }
  return { ok: true, matriz: doc };
}

/**
 * Funde a medicao NOVA de um defeito com a que ja estava na matriz, preservando as execucoes de
 * gates que a rodada nova nao incluiu.
 *
 * ## O bug que isto conserta (achado medindo, nao pensando)
 *
 * A fusao era por `defeito`: a linha nova substituia a antiga inteira. Com `--gates`, uma rodada
 * parcial de `indice-orfao` (so os gates de docs) apagou a execucao do `test` medida na rodada
 * anterior — e `docs:indice`, que a medicao com o vitest tinha mostrado CO-PEGADO, reapareceu no
 * relatorio como `[SO ELE]`.
 *
 * Ou seja: a forma mais cara de errar aqui, exclusividade FABRICADA a partir de dado que existia
 * e foi descartado. Fundir por `(defeito, gate)` mantem cada celula medida ate ser re-medida.
 *
 * `parouCedo` propaga por OU: uma linha que parou cedo em qualquer das rodadas nunca vira
 * exclusiva. Conservador de proposito — o erro tolerado e deixar de reconhecer um exclusivo, nunca
 * inventar um.
 *
 * ## So funde a MESMA sabotagem, medida validamente dos dois lados (parecer Codex 2026-09-10)
 *
 * A fusao por gate ignorava `defeitoFingerprint` e `invalido`. Duas fabricacoes saiam dali:
 * execucoes de uma sabotagem VELHA (o `.def` mudou, ou ganhou dever de casa) grudavam na linha da
 * sabotagem nova, como se tivessem sido medidas contra ela; e execucoes de uma rodada INVALIDADA
 * (ex.: um gate estourou o tempo no meio) ressuscitavam numa linha valida. Nos tres casos a linha
 * nova substitui a antiga inteira — descartar dado de proveniencia duvidosa e o lado barato.
 *
 * ## A celula herdada do gate EXCLUIDO fica DEFASADA (parecer Codex 2026-09-14)
 *
 * Numa rodada que tirou um gate por vermelho no baseline (`excluidosDaRodada`), a celula antiga dele
 * seguiria fechando a linha re-medida: o verde de um regime em que o gate novo nem existia, somado
 * ao vermelho unico do gate novo, certificaria `[SO ELE]` para o novo. Descartar a celula tambem nao
 * serve — sem nenhuma execucao valida, o `exclusividade` passaria a reprovar GATE_NOVO contra si
 * mesmo. Ela fica, marcada em `defasados`, ate uma rodada que re-execute o gate.
 */
export function fundirLinhas(
  antiga: LinhaMatriz | undefined,
  nova: LinhaMatriz,
  excluidosDaRodada: readonly string[] = [],
): LinhaMatriz {
  if (!antiga) return nova;
  if (antiga.defeitoFingerprint !== nova.defeitoFingerprint || antiga.invalido || nova.invalido) return nova;
  const porGate = new Map(antiga.execucoes.map((e) => [e.gate, e]));
  for (const e of nova.execucoes) porGate.set(e.gate, e);
  const fundida: LinhaMatriz = {
    ...nova,
    execucoes: [...porGate.values()].sort((a, b) => a.gate.localeCompare(b.gate)),
    parouCedo: antiga.parouCedo || nova.parouCedo,
  };
  // A marca so vale para celula HERDADA: quem a rodada nova executou esta em dia, e quem nao tem
  // celula nenhuma ja deixa a linha incompleta sem ajuda.
  const executadosAgora = new Set(nova.execucoes.map((e) => e.gate));
  const defasados = [...new Set([...(antiga.defasados ?? []), ...excluidosDaRodada])]
    .filter((g) => porGate.has(g) && !executadosAgora.has(g))
    .sort();
  if (defasados.length) fundida.defasados = defasados;
  else delete fundida.defasados;
  return fundida;
}

export interface Exclusividade {
  gate: string;
  /**
   * Defeitos em que ele foi o UNICO vermelho numa linha COMPLETA: todo gate do universo executado,
   * com a invocacao do CI, sem poda. So isto e `[SO ELE]`.
   */
  exclusivos: string[];
  /**
   * Defeitos em que ele foi o unico vermelho ENTRE OS QUE RODARAM, numa linha que nao rodou todo o
   * universo. Nao e exclusivo (os ausentes sao DESCONHECIDOS) nem redundante (ninguem mostrou outro
   * detector): e medicao que nao terminou.
   */
  inconclusivos: string[];
  pegou: string[];
  /** Linhas VALIDAS em que o gate foi executado com a invocacao do CI. So isto e medicao DELE. */
  rodou: string[];
  naoMedido: string[];
  /**
   * True se ALGUM defeito do corpus declara este gate em `@suspeito` — ou seja, se o corpus
   * chegou a MIRAR nele.
   *
   * Sem esta distincao a ferramenta comete, contra si mesma, a falha que existe para evitar. Na
   * primeira medicao real o `test` (vitest) apareceu com exclusividade zero e foi rotulado
   * "redundante" — quando a verdade e que nenhum dos 6 defeitos do corpus era de codigo de
   * aplicacao. Zero ali nao media redundancia: media um corpus que nunca apontou para ele.
   *
   * `@suspeito` continua sem podar NADA da medicao — todo gate roda contra todo defeito. Ele so
   * decide como o RESULTADO e rotulado, que e a diferenca entre informar e enganar.
   */
  corpusMirou: boolean;
  msTotal: number;
  msMediana: number;
}

export interface OpcoesDerivacao {
  /**
   * Os gates que uma linha precisa ter executado para CERTIFICAR exclusivo — os bloqueantes do
   * ci.yml de hoje. Sem ele, o baseline acumulado da matriz (maior, logo mais conservador).
   */
  universo?: readonly string[];
  /**
   * `assinaturaInvocacao` da invocacao ATUAL do CI por gate. Com ele, execucao de invocacao
   * diferente (ou legada, quando o CI nao roda `bun run <gate>` cru) nao conta como execucao.
   */
  assinaturas?: ReadonlyMap<string, string>;
}

/**
 * ## Desconhecido nunca e "nao reprovou" — nem para PODA, nem para COMPLETUDE
 *
 * `parouCedo` ja impedia a linha podada de certificar exclusivo. O resto da mesma classe seguia
 * aberto: uma linha medida com `--gates` (7 de 31 gates, na matriz real de 2026-09-10) tinha 1
 * vermelho, `parouCedo=false` e saia `[SO ELE]` — os 24 ausentes lidos como verdes. Certificar
 * agora exige, POR NOME, cada gate do universo executado validamente; o unico vermelho de uma
 * linha incompleta vira INCONCLUSIVO. E a execucao so conta se rodou o que o CI roda: o `tsc` que
 * o motor media era `bun run tsc`, no-op contra o tsconfig raiz — verde que nao e evidencia.
 */
export function derivar(m: Matriz, opts: OpcoesDerivacao = {}): Exclusividade[] {
  const universo = [...new Set(opts.universo ?? m.baseline.map((b) => b.gate))];
  const noUniverso = new Set(universo);
  const porGate = new Map<string, Exclusividade>();
  const pega = (g: string): Exclusividade => {
    let e = porGate.get(g);
    if (!e) {
      e = {
        gate: g,
        exclusivos: [],
        inconclusivos: [],
        pegou: [],
        rodou: [],
        naoMedido: [],
        // A mira so conta em linha VALIDA: uma linha invalida mirou, mas nao mediu nada.
        corpusMirou: m.linhas.some((l) => l.suspeito === g && !l.invalido),
        msTotal: 0,
        msMediana: 0,
      };
      porGate.set(g, e);
    }
    return e;
  };
  const compativel = (exec: ExecucaoGate): boolean => {
    if (!opts.assinaturas) return true;
    const atual = opts.assinaturas.get(exec.gate);
    return atual !== undefined && atual === (exec.invocacao ?? assinaturaLegada(exec.gate));
  };
  const duracoes = new Map<string, number[]>();

  // Todo gate do universo entra no resultado, mesmo que nao apareca em nenhuma linha valida.
  // Sem isto, um gate cujas unicas linhas foram INVALIDADAS simplesmente sumia da derivacao — e
  // sumir do relatorio e a pior forma de exclusividade zero: a que nem se sabe que existe.
  for (const g of universo) pega(g);

  for (const linha of m.linhas) {
    // Execucao de gate fora do universo (saiu do CI) nao pesa: exclusividade e relativa aos gates
    // que existem hoje. Execucao de invocacao incompativel nao e execucao.
    const validas = linha.execucoes.filter((e) => noUniverso.has(e.gate) && compativel(e));
    const rodados = new Set(validas.map((e) => e.gate));
    for (const g of universo) if (linha.invalido || !rodados.has(g)) pega(g).naoMedido.push(linha.defeito);

    if (linha.invalido) continue;
    const vermelhos = validas.filter((e) => e.reprovou);
    // Linha podada ja teve >=2 vermelhos: exclusividade REFUTADA, nem inconclusiva.
    const refutada = linha.parouCedo || vermelhos.length >= 2;
    // Celula DEFASADA conta como execucao (acima) e nunca como completude: e de outro regime.
    const defasada = (linha.defasados ?? []).some((g) => noUniverso.has(g));
    const completa = !defasada && universo.every((g) => rodados.has(g));

    for (const exec of validas) {
      const e = pega(exec.gate);
      e.rodou.push(linha.defeito);
      if (!duracoes.has(exec.gate)) duracoes.set(exec.gate, []);
      duracoes.get(exec.gate)!.push(exec.ms);
      e.msTotal += exec.ms;
      if (!exec.reprovou) continue;
      e.pegou.push(linha.defeito);
      if (!refutada) (completa ? e.exclusivos : e.inconclusivos).push(linha.defeito);
    }
  }

  for (const [g, ds] of duracoes) {
    const ord = [...ds].sort((a, b) => a - b);
    pega(g).msMediana = ord.length ? ord[Math.floor(ord.length / 2)] : 0;
  }

  return [...porGate.values()].sort((a, b) => a.gate.localeCompare(b.gate));
}

// ---------------------------------------------------------------------------------------------
// Veredito (o que o gate barato do CI imprime)
// ---------------------------------------------------------------------------------------------

/** As severidades que o gate emite — e as UNICAS que a sonda do motor aceita ler. */
const SEVERIDADES = ['REPROVA', 'AVISA', 'RELATA'] as const;
type Severidade = (typeof SEVERIDADES)[number];

type CodigoVeredito =
  | 'GATE_NOVO_SEM_EXCLUSIVIDADE'
  | RecusaDaMatriz['codigo']
  | 'LINHA_PODRE'
  | 'EXCLUSIVIDADE_ZERO'
  | 'EXCLUSIVIDADE_INCONCLUSIVA'
  | 'CORPUS_NAO_MIROU'
  | 'FRESCOR_INDISPONIVEL';

export interface Veredito {
  severidade: Severidade;
  gate: string;
  codigo: CodigoVeredito;
  motivo: string;
}

/**
 * A tabela de severidade, e por que ela nao e toda REPROVA:
 *
 *   leitura RECUSADA               -> REPROVA, uma so, com o codigo da recusa (`lerMatriz`): matriz
 *                                    ausente, ilegivel, de outro schema ou fora da forma. Nenhum
 *                                    veredito e calculado sobre dado que o schema de hoje nao le.
 *   gate NOVO sem linha exclusiva  -> REPROVA. E o objetivo declarado da maquina: quem acrescenta
 *                                    um gate paga a prova de que ele pega algo que ninguem pega.
 *   fonte do gate mudou            -> AVISA. Reprovar apodreceria a cada edicao de gate e viraria
 *                                    friccao que se contorna — sinal que ninguem le e pior que
 *                                    sinal nenhum, porque custa e ainda ensina a ignorar.
 *   exclusividade zero (existente) -> RELATA. Corte e decisao do founder; a ferramenta informa.
 *
 * ## "Medido" e EXECUTADO contra defeito valido — nunca "apareceu na matriz"
 *
 * O criterio era `pegou + naoMedido > 0`, e `naoMedido` e justamente a lista de defeitos em que o
 * gate NAO rodou. Na matriz real de 2026-09-10, `sonda:autentica` (podado: `sonda:bump` e
 * `sonda:fingerprint` pegaram primeiro, por bytes) e `gate:ambiente` tinham 0 execucoes em linha
 * valida e 11 `naoMedido` cada — e saiam sem REPROVA e sem RELATA, silencio total. Ausencia de dado
 * virando aprovacao, dentro da ferramenta que existe para nao deixar isso acontecer.
 */
export function avaliar(
  leitura: LeituraDaMatriz,
  gates: GateAlvo[],
  fpAtual: Map<string, { fingerprint: string; resolvida: boolean }>,
  assinaturas?: ReadonlyMap<string, string>,
): Veredito[] {
  const out: Veredito[] = [];
  const candidatos = gates.filter((g) => g.bloqueiaPR);

  if (!leitura.ok) {
    out.push({ severidade: 'REPROVA', gate: '(todos)', codigo: leitura.codigo, motivo: leitura.motivo });
    return out;
  }
  const m = leitura.matriz;

  const dispensados = new Set(m.dispensados.map((d) => d.gate));
  const exclus = new Map(derivar(m, { universo: candidatos.map((g) => g.nome), assinaturas }).map((e) => [e.gate, e]));

  for (const g of candidatos) {
    const e = exclus.get(g.nome);
    const medido = e !== undefined && e.rodou.length > 0;

    if (!medido && !dispensados.has(g.nome)) {
      const fora = e?.naoMedido.length ?? 0;
      out.push({
        severidade: 'REPROVA',
        gate: g.nome,
        codigo: 'GATE_NOVO_SEM_EXCLUSIVIDADE',
        motivo:
          (fora > 0
            ? `gate bloqueante NUNCA EXECUTADO contra defeito valido — ${fora} linha(s) da matriz o deixaram ` +
              `de fora (poda por custo, --gates, linha invalida ou invocacao diferente da do CI). Ausencia de ` +
              `execucao NAO e medicao. `
            : `gate bloqueante sem NENHUM defeito medido. `) +
          `Um gate custa segundos em todo PR, para sempre; a prova de que ele pega algo que os outros ` +
          `nao pegam e o preco. Escreva um defeito em ${CORPUS_DIR}/ (o motor executa o @suspeito mesmo ` +
          `quando a poda o deixaria de fora) e rode \`bun run exclusividade:medir\`.`,
      });
      continue;
    }
    if (!e) continue;

    const fp = fpAtual.get(g.nome);
    if (fp && !fp.resolvida) {
      out.push({
        severidade: 'AVISA',
        gate: g.nome,
        codigo: 'FRESCOR_INDISPONIVEL',
        motivo: 'nenhum arquivo-fonte resolvido a partir do comando — frescor NAO verificavel.',
      });
    } else if (fp) {
      const antigo = m.linhas.flatMap((l) => l.execucoes).find((x) => x.gate === g.nome)?.fingerprint;
      if (antigo && antigo !== fp.fingerprint) {
        out.push({
          severidade: 'AVISA',
          gate: g.nome,
          codigo: 'LINHA_PODRE',
          motivo: `a fonte mudou desde a medicao (${antigo} -> ${fp.fingerprint}); re-meca quando puder.`,
        });
      }
    }

    if (medido && e.exclusivos.length === 0 && e.pegou.length > 0 && e.inconclusivos.length > 0) {
      // "Outro gate tambem pegou" seria FALSO aqui: nas linhas inconclusivas ninguem mais reprovou —
      // os outros nao RODARAM. Nem exclusivo, nem redundante: medicao que nao terminou.
      out.push({
        severidade: 'RELATA',
        gate: g.nome,
        codigo: 'EXCLUSIVIDADE_INCONCLUSIVA',
        motivo:
          `foi o UNICO vermelho em ${e.inconclusivos.length} defeito(s) (${e.inconclusivos.join(', ')}), mas ` +
          `nenhuma dessas linhas tem todo gate bloqueante executado EM DIA com a invocacao do CI — os ausentes ` +
          `(ou defasados) sao DESCONHECIDOS. Nao certifica exclusividade e NAO e redundancia; re-meca a linha ` +
          `com todos os gates.`,
      });
    } else if (medido && e.exclusivos.length === 0 && e.pegou.length > 0) {
      // Zero so pode ser lido como REDUNDANCIA se o corpus chegou a mirar neste gate. Se nenhum
      // defeito o declara em `@suspeito`, o zero mede o corpus, nao o gate — e chamar isso de
      // redundancia seria a ferramenta cometendo contra si a falha que ela existe para evitar.
      out.push(
        e.corpusMirou
          ? {
              severidade: 'RELATA',
              gate: g.nome,
              codigo: 'EXCLUSIVIDADE_ZERO',
              motivo:
                `pegou ${e.pegou.length} de ${m.linhas.length} defeito(s) do corpus, e em NENHUM foi o ` +
                `unico — outro gate tambem pegou. Isto NAO e "nao pega nada": e redundancia medida ` +
                `NESTE corpus de ${m.linhas.length}.`,
            }
          : {
              severidade: 'RELATA',
              gate: g.nome,
              codigo: 'CORPUS_NAO_MIROU',
              motivo:
                `pegou ${e.pegou.length} defeito(s) de carona, mas NENHUM dos ${m.linhas.length} do ` +
                `corpus foi escrito mirando nele (@suspeito). Zero aqui mede o CORPUS, nao o gate — ` +
                `escreva um defeito do dominio dele antes de concluir qualquer coisa.`,
            },
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// O `exclusividade` no baseline do MOTOR — o unico vermelho que a propria rodada resolve
// ---------------------------------------------------------------------------------------------

/** O gate que le a matriz que o motor escreve. */
export const GATE_EXCLUSIVIDADE = 'exclusividade';

interface LeituraDoVermelho {
  /** Exit da execucao do BASELINE, com a invocacao do CI. `null` = morto por sinal ou estouro. */
  rcBaseline: number | null;
  /** Exit da SONDA: a mesma invocacao + `--json`, logo depois, sobre a mesma arvore (write-guard). */
  rcSonda: number | null;
  /** stdout da sonda. */
  saidaSonda: string;
  /** Os gates que ESTA rodada executa, fora o proprio `exclusividade`. */
  gatesDaRodada: readonly string[];
}

type DecisaoDeExclusao = { excluir: true; gatesNovos: string[] } | { excluir: false; motivo: string };

/**
 * ## A circularidade que isto desfaz
 *
 * O gate `exclusividade` e bloqueante, logo o motor o mede — e ele le a matriz que o motor ESCREVE.
 * Acrescente um gate G ao `ci.yml` e ele reprova `GATE_NOVO_SEM_EXCLUSIVIDADE` (G sem execucao
 * valida); no baseline do motor ele fica vermelho, a guarda 1b aborta, e a execucao de G — a unica
 * coisa que o poria verde — nunca e gravada. Os contornos eram `--gates <todos menos ele>`, a mao,
 * e `--ignorar-baseline`, que ignora QUALQUER vermelho.
 *
 * ## Por que EXCLUIR da rodada, e nunca "ignorar o vermelho"
 *
 * Gate vermelho antes da sabotagem e vermelho em todo defeito: medi-lo fabricaria um detector
 * universal. Fora da rodada ele nao produz execucao nenhuma — as linhas ficam sem ele, e a
 * derivacao ja sabe que linha sem o universo inteiro nao certifica ninguem (`[inconcl]`).
 *
 * ## Por que tao estreito (cada criterio falha FECHADO: na duvida, o aborto de sempre)
 *
 *   - exit 1 nas DUAS leituras: 1 e o exit de REPROVA; 2 e erro do proprio gate e `null` e
 *     ausencia de dado. Baseline 1 com sonda 0 e leitura que discorda de si mesma.
 *   - JSON no contrato e ancora intacta: a ancora quebrada tambem sai 1, e nao e gate novo.
 *   - TODA REPROVA e GATE_NOVO: um unico motivo alheio (ex.: MATRIZ_AUSENTE) e vermelho que a
 *     rodada nao resolve.
 *   - todo gate novo e EXECUTADO por esta rodada: se o `--gates` o deixou de fora, a rodada nao
 *     grava a execucao que o resolveria — o vermelho seguiria, e excluir so esconderia o porque.
 *     Se o gate novo e o proprio `exclusividade`, exclui-lo nunca o resolveria.
 */
export function exclusividadeVermelhaSoPorGateNovo(leitura: LeituraDoVermelho): DecisaoDeExclusao {
  const { rcBaseline, rcSonda, saidaSonda, gatesDaRodada } = leitura;
  const recusa = (motivo: string): DecisaoDeExclusao => ({ excluir: false, motivo });
  const exit = (rc: number | null) => (rc === null ? 'sem exit (sinal ou estouro)' : String(rc));

  if (rcBaseline !== 1) {
    return recusa(`RC-BASELINE o baseline saiu ${exit(rcBaseline)} — so o exit 1 e REPROVA (2 e erro do proprio gate)`);
  }
  if (rcSonda !== 1) {
    return recusa(`RC-SONDA a sonda --json saiu ${exit(rcSonda)} e o baseline saiu 1 — as duas leituras do mesmo gate discordam`);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(saidaSonda);
  } catch {
    return recusa(`SONDA-ILEGIVEL o stdout da sonda --json nao e JSON: ${JSON.stringify(saidaSonda.trim().slice(0, 80))}`);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return recusa('SONDA-FORA-DO-CONTRATO o JSON da sonda nao e um objeto');
  }
  const { ancoraQuebrada, vereditos } = doc as Record<string, unknown>;
  if (!Array.isArray(ancoraQuebrada) || !Array.isArray(vereditos)) {
    return recusa('SONDA-FORA-DO-CONTRATO faltam as listas `ancoraQuebrada` e `vereditos`');
  }
  const lidos: Veredito[] = [];
  for (const v of vereditos) {
    const x = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    // Severidade fora das que o gate emite e protocolo desconhecido — nunca "nao e REPROVA, entao passa".
    if (typeof x.gate !== 'string' || !SEVERIDADES.some((s) => s === x.severidade)) {
      return recusa(`SONDA-FORA-DO-CONTRATO veredito que o gate nao emite: ${JSON.stringify(v)?.slice(0, 120)}`);
    }
    lidos.push(x as unknown as Veredito);
  }

  if (ancoraQuebrada.length > 0) {
    const codigos = ancoraQuebrada.map((a) => String((a as { codigo?: unknown } | null)?.codigo)).join(', ');
    return recusa(`ANCORA-QUEBRADA ${codigos} — a ancora da raiz tambem sai 1, e nao e gate novo`);
  }
  const reprovas = lidos.filter((v) => v.severidade === 'REPROVA');
  if (reprovas.length === 0) {
    return recusa('SEM-REPROVA exit 1 sem nenhuma REPROVA no --json — vermelho sem motivo legivel');
  }
  const alheias = reprovas.filter((v) => v.codigo !== 'GATE_NOVO_SEM_EXCLUSIVIDADE');
  if (alheias.length > 0) {
    return recusa(`REPROVA-ALHEIA ${alheias.map((v) => `${v.codigo} (${v.gate})`).join(', ')} — vermelho que esta rodada nao resolve`);
  }
  const novos = [...new Set(reprovas.map((v) => v.gate))].sort();
  if (novos.includes(GATE_EXCLUSIVIDADE)) {
    return recusa(`GATE-NOVO-E-O-PROPRIO ${GATE_EXCLUSIVIDADE} — tira-lo da rodada nunca gravaria a execucao que o livraria`);
  }
  const naRodada = new Set(gatesDaRodada);
  const fora = novos.filter((g) => !naRodada.has(g));
  if (fora.length > 0) {
    return recusa(`GATE-NOVO-FORA-DA-RODADA ${fora.join(', ')} — esta rodada nao o executa, entao nao grava a execucao que o resolveria`);
  }
  return { excluir: true, gatesNovos: novos };
}

/**
 * Resumo humano. O denominador anda GRUDADO no numero — sem ele, zero le como "inutil". E o
 * `rodou` anda junto do `pegou`: "pegou 0" de um gate que rodou em 7 linhas e de um que nao rodou
 * em nenhuma sao afirmacoes opostas, e sem o `rodou` as duas se imprimiam iguais.
 */
export function resumir(m: Matriz, opts: OpcoesDerivacao = {}): string {
  const n = (x: number) => String(x).padStart(2);
  const derivados = derivar(m, opts);
  const linhas = derivados
    .filter((e) => e.rodou.length + e.naoMedido.length > 0)
    .map((e) => {
      const excl = e.exclusivos.length;
      const marca =
        excl > 0
          ? '[SO ELE]'
          : e.inconclusivos.length > 0
            ? '[inconcl]'
            : !e.corpusMirou
              ? '[s/ mira]'
              : e.pegou.length > 0
                ? '[redund]'
                : '[      ]';
      return (
        `${marca.padEnd(9)} ${e.gate.padEnd(34)} exclusivos ${n(excl)}/${m.linhas.length}` +
        ` - inconcl ${n(e.inconclusivos.length)} - pegou ${n(e.pegou.length)} de ${n(e.rodou.length)} rodado(s)` +
        ` - mediana ${String(e.msMediana).padStart(6)}ms`
      );
    });
  const comDever = m.linhas.filter((l) => l.deveres?.length).map((l) => `${l.defeito} [${l.deveres!.join(' + ')}]`);
  return [
    `matriz de exclusividade — ${m.linhas.length} defeito(s) x ${derivados.length} gate(s), medida em ${m.medidoEm}`,
    ...linhas,
    `   [SO ELE]  = ha defeito que SO ele pega, numa linha que rodou TODO gate do universo`,
    `   [inconcl] = unico vermelho entre os que rodaram, mas a linha nao rodou todo o universo (ou herdou celula defasada) — nao certifica`,
    `   [redund]  = o corpus mirou nele e tudo que pega, outro tambem pega (NESTE corpus de ${m.linhas.length})`,
    `   [s/ mira] = nenhum defeito do corpus foi escrito para ele — zero aqui mede o CORPUS, nao o gate`,
    ...(comDever.length ? [`   linhas do autor DILIGENTE (com dever de casa): ${comDever.join('; ')}`] : []),
  ].join('\n');
}
