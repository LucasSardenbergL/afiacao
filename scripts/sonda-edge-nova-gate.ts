#!/usr/bin/env bun
/**
 * sonda-edge-nova-gate.ts — "nasceu edge? então a instrumentação foi DECIDIDA, não omitida".
 * ============================================================================================
 *
 * ## O buraco que ele tapa
 *
 * Os gates de sonda que já existem têm todos o mesmo universo: as edges JÁ instrumentadas. O
 * `sonda:bump` só olha edge com `versao.ts` na BASE; o `sonda:fingerprint` calcula sobre
 * `edgesInstrumentadas()`, que é a PRESENÇA de `versao.ts` na pasta; e o denominador do `pendencias:deploy` sai do
 * mapa commitado. Quando o universo de um gate é lista derivada de artefato OPT-IN, quem nunca
 * entrou não reprova: some.
 *
 * MEDIDO, não suposto (2026-08-28, `docs/historico/verificar-sonda-versao.md` §14): a edge
 * `analytics-outbox-drain` nasceu no #2035 sem `versao.ts` e fora do mapa de fingerprints.
 * Nenhum gate reclamou — e por DESENHO, não por bug. `cobertura: 39/39` era 39/40: o 40º não
 * estava reprovado, estava ausente do denominador. Ela foi instrumentada no #2094; este gate é
 * para a PRÓXIMA.
 *
 * ## A régua
 *
 * Uma pasta de `supabase/functions/` é NOVA quando tem `index.ts` no HEAD e não tinha na BASE.
 * A entrada — não o diff — é o que decide: a fatia pode tocar só um `helper.ts`, e pasta que
 * ganha arquivo sem ganhar `index.ts` não é edge servida. Ler os dois lados é o que separa
 * NASCER de MUDAR (quem cuida é o `sonda:bump`) e de SUMIR (que não é problema de ninguém).
 *
 * Edge nova precisa de UMA das duas, e o gate não escolhe qual:
 *
 *   (a) `versao.ts` com `export const VERSAO` legível E entrada em `_shared/sonda-fingerprints.ts`;
 *   (b) o nome em `DISPENSAS`, aqui embaixo, com motivo tipado e o `porque` assinado.
 *
 * ## Por que (b) existe — e por que ela não é de graça
 *
 * Das 95 pastas de edge do repo, 40 são instrumentadas. As 55 restantes NÃO são dívida: a maioria
 * é leitura pura, e a terceira leva (#1767) excluiu essa classe DE PROPÓSITO — "chamá-la já é
 * grátis, então a sonda não resolve problema que ela tenha". Um gate que exigisse `versao.ts` de
 * toda edge nova seria imposto sobre quem não precisa de sonda, e gate assim é o que alguém
 * afrouxa no primeiro atrito. O que este gate proíbe não é a dispensa: é a OMISSÃO.
 *
 * Só que lista de dispensa livre apodrece. Então ela é verificada no que dá para verificar:
 * `leitura-pura` é uma AFIRMAÇÃO sobre o código, e o gate a falsifica — corpo com a cadeia
 * PostgREST de escrita reprova a dispensa. Os motivos não-checáveis por texto continuam existindo
 * e o gate declara esse limite em vez de fingir que cobre. O `porque` é exigido não-vazio e nada
 * além disso — policiar a prosa seria teatro; o valor está em a decisão aparecer ASSINADA no diff.
 *
 * O buraco que essa verificação quase teve está registrado porque quase passou: `.rpc()` também
 * escreve, e o texto não diz qual RPC lê e qual grava. Medido nas 56 pastas sem `versao.ts`
 * (2026-08-28): 31 escrevem por PostgREST, 12 chamam `.rpc()`, 20 não fazem nem um nem outro.
 * Se `leitura-pura` cobrisse as duas famílias, 12 edges ganhariam verde AUTO-VERIFICADO sobre
 * escrita invisível — e a `analytics-outbox-drain`, o caso que motivou este gate, é uma delas
 * (ela grava por `analytics_outbox_aceitar`). Daí `leitura-via-rpc` ser motivo separado, com o
 * `porque` obrigado a NOMEAR o RPC: o gate não lê o corpo da função, então quem lê é a review, e
 * ela precisa do nome. Quem descobriu isso foi o teste de controle positivo, não o desenho.
 *
 * ## O que fica DE FORA
 *
 * · `pull_request`-only, como o `sonda:bump`: no `push`/`schedule` da main não existe "a fatia"
 *   contra a qual medir (merge-base com origin/main é o próprio HEAD ⇒ diff vazio). A metade
 *   descoberta é a edge que nasce por push DIRETO do Lovable, sem PR.
 * · A coerência da lista contra a árvore (dispensa de edge que não existe / que hoje tem
 *   `versao.ts`) é gate de ESTADO, não de diff — vive nos testes-sentinela do arquivo `.test.ts`,
 *   que o `bun run test` roda em todo evento.
 *
 * ## Fail-CLOSED
 *
 * Sem base determinável, com `--head` que não resolve, ou com `git diff` que falha, o gate
 * REPROVA. Lista vazia por ERRO é indistinguível de lista vazia por mérito.
 *
 * Uso:
 *   bun run sonda:nova                        # base = merge-base com origin/main (ou GITHUB_BASE_REF)
 *   bun scripts/sonda-edge-nova-gate.ts --base <rev> [--head <rev>]
 */
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';
import { ARQ_MAPA, parsearMapa } from './sonda-fingerprint';
import {
  RAIZ_EDGES,
  contaComoCorpo,
  extrairVersao,
  git,
  lerNaRev,
  lerNoHead,
  resolverBase,
  type LeitorFonte,
} from './sonda-versao-bump-gate';

/**
 * O vocabulário de dispensa, ordenado do mais VERIFICÁVEL ao menos.
 *
 * A divisão não é estética: `leitura-pura` e `leitura-via-rpc` são afirmações sobre o CÓDIGO, e o
 * gate as falsifica contra a fonte; os outros dois são afirmações sobre o mundo (o que a pasta é,
 * o que outro marcador prova), que texto nenhum decide — nesses o gate registra a assinatura e
 * declara o limite, em vez de fingir que cobre.
 *
 * MEDIDO nas 56 pastas sem `versao.ts` de 2026-08-28: 31 escrevem por PostgREST, 12 chamam
 * `.rpc()`, 20 não fazem nem um nem outro. É por isso que `leitura-pura` e `leitura-via-rpc` são
 * motivos SEPARADOS: juntá-los daria um verde auto-verificado a 12 edges cuja escrita o gate não
 * consegue ver — e foi exatamente essa a forma do caso que motivou o gate (a
 * `analytics-outbox-drain` escreve por `analytics_outbox_aceitar`, um RPC).
 */
export type MotivoDispensa =
  /** nem mutação PostgREST nem `.rpc()` — VERIFICADO contra a fonte */
  | 'leitura-pura'
  /** só lê, mas por RPC: o gate não sabe o que o RPC faz, então o `porque` tem de NOMEÁ-LO */
  | 'leitura-via-rpc'
  /** a pasta não vira bundle servido (utilitário, descontinuada) — asserção humana */
  | 'sem-deploy-proprio'
  /** canária versionada já discrimina o bundle desta edge — asserção humana */
  | 'prova-por-outro-marcador';

export const MOTIVOS_DISPENSA: readonly MotivoDispensa[] = [
  'leitura-pura',
  'leitura-via-rpc',
  'sem-deploy-proprio',
  'prova-por-outro-marcador',
];

export interface Dispensa {
  motivo: MotivoDispensa;
  porque: string;
}

export interface EstadoEdgeNova {
  edge: string;
  corpo: { caminho: string; fonte: string }[];
  versao: string | null;
  temMarcador: boolean;
  noMapa: boolean;
}

export type MotivoAchado =
  | 'sem-decisao'
  | 'marcador-ilegivel'
  | 'fora-do-mapa'
  | 'dispensa-invalida'
  | 'dispensa-falsa'
  | 'decisao-dupla';

export interface Achado {
  edge: string;
  motivo: MotivoAchado;
  detalhe: string;
}

/**
 * As edges que NASCERAM declarando que a sonda não resolve problema que elas tenham.
 *
 * Entrar aqui é uma decisão, não um atalho: o nome aparece no diff, o `porque` é assinado, e
 * `leitura-pura` é FALSIFICADA pelo gate contra o corpo da edge. Se a edge passar a escrever
 * depois, o teste-sentinela de estado (no `.test.ts`) cobra a saída da lista.
 *
 * Vazia hoje de propósito: ela cobre o que NASCE daqui para a frente, e as 55 não-instrumentadas
 * que já existiam não passam por este gate — retroalimentá-la seria inventar assinatura de
 * decisão que ninguém tomou.
 */
export const DISPENSAS: Record<string, Dispensa> = {};

/**
 * ⚠️ LIMITE das duas detecções abaixo: elas leem o corpo da PASTA da edge, não o fecho transitivo
 * de `_shared/`. Escrita que chega por helper compartilhado não é vista — quem enxerga esse
 * fan-out é o `sonda:fingerprint`, e ele só age sobre edge JÁ instrumentada. Declarado em vez de
 * silenciado: o gate promete falsificar a dispensa, e prometer mais do que mede é a mesma classe
 * de falha que ele existe para tapar.
 */

/**
 * A cadeia PostgREST de escrita: `.from(...)` seguido de um método de mutação, sem atravessar
 * fim de statement (`[^;{}]`). A âncora no `.from(` e o corte no `;`/`{`/`}` são o que separa
 * `sb.from('t').insert(x)` de `cache.delete(chave)` — precisão > recall, porque gate que grita
 * errado treina a ignorar.
 */
const RE_MUTACAO = /\.from\s*\(\s*[^)]*\)[^;{}]{0,300}?\.(insert|upsert|update|delete)\s*\(/;

export function detectarMutacao(fonte: string): string | null {
  const m = removerComentarios(fonte).match(RE_MUTACAO);
  return m ? m[1] : null;
}

/** `.rpc('nome')` com nome LITERAL. Chamada dinâmica não devolve nada — não se inventa nome. */
const RE_RPC = /\.rpc\s*\(\s*(["'`])([A-Za-z_][A-Za-z0-9_]*)\1/g;

export function detectarRpcs(fonte: string): string[] {
  const nomes: string[] = [];
  for (const m of removerComentarios(fonte).matchAll(RE_RPC)) {
    if (!nomes.includes(m[2])) nomes.push(m[2]);
  }
  return nomes;
}

export function auditarEdgesNovas(
  novas: EstadoEdgeNova[],
  dispensas: Record<string, Dispensa> = DISPENSAS,
): Achado[] {
  const achados: Achado[] = [];
  for (const e of novas) {
    const d = dispensas[e.edge];
    if (d) {
      if (e.temMarcador) {
        achados.push({
          edge: e.edge,
          motivo: 'decisao-dupla',
          detalhe: `está em DISPENSAS (\`${d.motivo}\`) e ao mesmo tempo tem \`versao.ts\``,
        });
        continue;
      }
      if (!MOTIVOS_DISPENSA.includes(d.motivo)) {
        achados.push({
          edge: e.edge,
          motivo: 'dispensa-invalida',
          detalhe: `motivo \`${d.motivo}\` fora do vocabulário (${MOTIVOS_DISPENSA.join(', ')})`,
        });
        continue;
      }
      if (d.porque.trim() === '') {
        achados.push({
          edge: e.edge,
          motivo: 'dispensa-invalida',
          detalhe: '`porque` em branco — dispensa sem justificativa assinada não é decisão, é depósito',
        });
        continue;
      }
      if (d.motivo === 'leitura-pura' || d.motivo === 'leitura-via-rpc') {
        const escrita = e.corpo
          .map((a) => ({ caminho: a.caminho, metodo: detectarMutacao(a.fonte) }))
          .find((a) => a.metodo !== null);
        if (escrita) {
          achados.push({
            edge: e.edge,
            motivo: 'dispensa-falsa',
            detalhe:
              `dispensada como \`${d.motivo}\`, mas ${escrita.caminho} escreve no banco ` +
              `(\`.${escrita.metodo}(\`)`,
          });
          continue;
        }
        const rpcs = [...new Set(e.corpo.flatMap((a) => detectarRpcs(a.fonte)))];
        if (d.motivo === 'leitura-pura' && rpcs.length > 0) {
          achados.push({
            edge: e.edge,
            motivo: 'dispensa-falsa',
            detalhe:
              `dispensada como \`leitura-pura\`, mas chama RPC (${rpcs.join(', ')}) e o gate não ` +
              'sabe se o RPC escreve — o motivo desta edge é `leitura-via-rpc`',
          });
          continue;
        }
        if (d.motivo === 'leitura-via-rpc' && rpcs.length > 0 && !rpcs.some((r) => d.porque.includes(r))) {
          achados.push({
            edge: e.edge,
            motivo: 'dispensa-invalida',
            detalhe:
              '`leitura-via-rpc` sem nomear o RPC no `porque` — o gate não lê o corpo da função, ' +
              `então quem lê é a review, e ela precisa do nome (chamados: ${rpcs.join(', ')})`,
          });
          continue;
        }
      }
      continue;
    }

    if (!e.temMarcador) {
      achados.push({ edge: e.edge, motivo: 'sem-decisao', detalhe: 'sem `versao.ts` e fora de DISPENSAS' });
      continue;
    }
    if (e.versao === null) {
      achados.push({
        edge: e.edge,
        motivo: 'marcador-ilegivel',
        detalhe: 'tem `versao.ts` mas não consegui ler `export const VERSAO`',
      });
      continue;
    }
    if (!e.noMapa) {
      achados.push({
        edge: e.edge,
        motivo: 'fora-do-mapa',
        detalhe: `marcador \`${e.versao}\` legível, mas a edge não tem entrada em sonda-fingerprints.ts`,
      });
    }
  }
  return achados;
}

// ─── I/O: git ────────────────────────────────────────────────────────────────────────────────

/** o arquivo cuja PRESENÇA define que a pasta é uma edge servida */
const ARQ_ENTRADA = 'index.ts';

/** o arquivo que carrega o marcador */
const ARQ_MARCADOR = 'versao.ts';

/**
 * Monta o estado das edges que NASCERAM nesta fatia — o miolo do coletor, SEM git.
 *
 * "Nova" é decidido pelo `index.ts`, não pelo diff: a fatia pode tocar só um `helper.ts`, e uma
 * pasta que ganha arquivo sem ganhar `index.ts` não é edge servida. Ler os dois lados (base e
 * head) é o que separa NASCER de MUDAR e de SUMIR — o diff sozinho não distingue os três.
 *
 * O leitor é injetado porque este é o seam onde o gate irmão levou seus dois falsos-verdes
 * (2026-08-25), ambos FORA do núcleo puro que tinha 23 testes verdes.
 */
export function montarEstadoNovas(
  tocados: string[],
  base: string,
  headRev: string | null,
  ler: LeitorFonte,
): EstadoEdgeNova[] {
  const porEdge = new Map<string, string[]>();
  for (const caminho of tocados) {
    const m = caminho.match(new RegExp(`^${RAIZ_EDGES}/([^/]+)/`));
    if (!m || m[1] === '_shared') continue;
    const lista = porEdge.get(m[1]) ?? [];
    lista.push(caminho);
    porEdge.set(m[1], lista);
  }

  const mapaHead = parsearMapa(ler(headRev, ARQ_MAPA) ?? '');
  const novas: EstadoEdgeNova[] = [];
  for (const [edge, arquivos] of [...porEdge].sort()) {
    const entrada = `${RAIZ_EDGES}/${edge}/${ARQ_ENTRADA}`;
    if (ler(base, entrada) !== null) continue; // já existia: é MUDANÇA, e quem cuida é o `sonda:bump`
    if (ler(headRev, entrada) === null) continue; // não existe no head: removida, ou pasta sem edge

    const fonteMarcador = ler(headRev, `${RAIZ_EDGES}/${edge}/${ARQ_MARCADOR}`);
    const corpo: EstadoEdgeNova['corpo'] = [];
    for (const caminho of [...new Set([...arquivos, entrada])].sort()) {
      if (!contaComoCorpo(caminho, edge)) continue;
      const fonte = ler(headRev, caminho);
      if (fonte !== null) corpo.push({ caminho, fonte });
    }

    novas.push({
      edge,
      corpo,
      versao: fonteMarcador === null ? null : extrairVersao(fonteMarcador),
      temMarcador: fonteMarcador !== null,
      noMapa: Object.prototype.hasOwnProperty.call(mapaHead, edge),
    });
  }
  return novas;
}

/**
 * Une o que o diff viu com o que ele NÃO PODE ver.
 *
 * `git diff` não lista untracked, e edge nova nasce untracked — a pasta existe no disco e não
 * está no índice. Medido na falsificação (2026-08-28): com a pasta criada e não adicionada, o
 * gate imprimia "✓ toda edge nascida nesta fatia tem a decisão TOMADA", isto é, verde por
 * CEGUEIRA no exato instante em que o autor roda o gate para saber se decidiu. O CI não veria
 * (lá tudo já está commitado), o que torna esse falso-verde só LOCAL — e local é onde a decisão
 * acontece.
 *
 * Comparando duas REVS (`--head <rev>`) não há árvore de trabalho a considerar, e untracked do
 * disco não pertence a nenhuma das duas: entra só quando o head é a árvore.
 */
export function unirTocados(doDiff: string[], untracked: string[], headRev: string | null): string[] {
  return headRev === null ? [...new Set([...doDiff, ...untracked])] : doDiff;
}

/** Coleta as edges que nasceram nesta fatia. */
export function coletarNovas(base: string, headRev: string | null): EstadoEdgeNova[] {
  const args = ['diff', '--name-only', base];
  if (headRev) args.push(headRev);
  args.push('--', RAIZ_EDGES);
  const { ok, saida } = git(args);
  if (!ok) {
    throw new Error(
      `\`git ${args.join(' ')}\` falhou. Sem diff não há o que medir, e não medir não é o ` +
        'mesmo que estar em ordem.',
    );
  }

  let untracked: string[] = [];
  if (headRev === null) {
    const outros = ['ls-files', '--others', '--exclude-standard', '--', RAIZ_EDGES];
    const r = git(outros);
    if (!r.ok) {
      throw new Error(
        `\`git ${outros.join(' ')}\` falhou. Edge nova nasce UNTRACKED — sem esta lista o gate ` +
          'ficaria cego exatamente na fatia que ele existe para ver.',
      );
    }
    untracked = r.saida.split('\n').filter((l) => l !== '');
  }

  const tocados = unirTocados(saida.split('\n').filter((l) => l !== ''), untracked, headRev);
  return montarEstadoNovas(tocados, base, headRev, (rev, caminho) =>
    rev === null ? lerNoHead(null, caminho) : lerNaRev(rev, caminho),
  );
}

const ARQ_GATE = 'scripts/sonda-edge-nova-gate.ts';

export function formatarAchado(a: Achado): string {
  const cabeca = `✗ ${a.edge}: ${a.detalhe}.`;
  switch (a.motivo) {
    case 'sem-decisao':
      return (
        `${cabeca}\n` +
        '  Edge nova precisa de UMA das duas — e o gate não escolhe qual:\n' +
        `    (a) instrumentar: criar ${RAIZ_EDGES}/${a.edge}/versao.ts com \`export const VERSAO\`\n` +
        '        (formato `vN.N-slug`) e rodar `bun run sonda:fingerprint --write`;\n' +
        `    (b) dispensar: adicionar "${a.edge}" a \`DISPENSAS\` em ${ARQ_GATE}, com motivo e\n` +
        '        `porque` assinado (leitura pura / sem deploy próprio / prova por outro marcador).\n' +
        '  O que este gate proíbe não é a dispensa — é a OMISSÃO. Sem marcador e sem dispensa, a\n' +
        '  edge some do denominador dos outros gates e a `cobertura` mente para cima.'
      );
    case 'marcador-ilegivel':
      return (
        `${cabeca}\n` +
        '  Marcador que o gate não lê é marcador que a sonda não serve. Exporte\n' +
        `  \`export const VERSAO = 'vN.N-slug'\` em ${RAIZ_EDGES}/${a.edge}/versao.ts.`
      );
    case 'fora-do-mapa':
      return (
        `${cabeca}\n` +
        '  A identidade servida pela sonda é o FINGERPRINT DA FONTE, não só o literal do marcador.\n' +
        '  Rode `bun run sonda:fingerprint --write` e commite o mapa.'
      );
    case 'dispensa-invalida':
      return (
        `${cabeca}\n` +
        `  Corrija a entrada "${a.edge}" em \`DISPENSAS\` (${ARQ_GATE}): motivo do vocabulário\n` +
        `  (${MOTIVOS_DISPENSA.join(' | ')}) e \`porque\` que um humano leia no dia em que discordar.`
      );
    case 'dispensa-falsa':
      return (
        `${cabeca}\n` +
        '  A exceção da terceira leva ("chamá-la já é grátis, então a sonda não resolve problema\n' +
        '  que ela tenha") vale para LEITURA. Instrumente a edge, ou troque o motivo por um que\n' +
        `  seja verdade (${MOTIVOS_DISPENSA.join(' | ')}).`
      );
    case 'decisao-dupla':
      return (
        `${cabeca}\n` +
        `  As duas saídas são exclusivas. Se a edge é instrumentada, tire "${a.edge}" de\n` +
        `  \`DISPENSAS\` em ${ARQ_GATE} — dispensa que sobra vira licença silenciosa depois.`
      );
  }
}

export function main(argv: string[]): number {
  const iBase = argv.indexOf('--base');
  const iHead = argv.indexOf('--head');
  const baseArg = iBase >= 0 ? argv[iBase + 1] : process.env.SONDA_BASE;
  const headRev = iHead >= 0 ? argv[iHead + 1] : null;

  const base = resolverBase(baseArg);
  if (base === null) {
    console.error(
      'sonda-edge-nova: ✗ não consegui determinar a BASE do diff (tentei ' +
        `${process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}, ` : ''}` +
        'origin/main, main).\n' +
        '  No CI: o checkout do job precisa de `fetch-depth: 0`.\n' +
        '  Local: `git fetch origin main`, ou passe `--base <rev>`.\n' +
        '  O gate REPROVA em vez de degradar — sem base, toda edge do repo pareceria nova.',
    );
    return 1;
  }

  if (iHead >= 0) {
    const r = headRev ? git(['rev-parse', '--verify', `${headRev}^{commit}`]) : { ok: false, saida: '' };
    if (!r.ok) {
      console.error(
        `sonda-edge-nova: ✗ \`--head ${headRev ?? '<sem valor>'}\` não resolve para um commit.\n` +
          '  O gate RECUSA em vez de medir contra o nada — rev que não resolve devolveria diff\n' +
          '  vazio, e diff vazio se lê como "nenhuma edge nasceu".',
      );
      return 1;
    }
  }

  let achados: Achado[];
  try {
    achados = auditarEdgesNovas(coletarNovas(base, headRev));
  } catch (e) {
    console.error(`sonda-edge-nova: ✗ ${mensagemDeErro(e) ?? 'erro sem mensagem ao coletar o diff'}`);
    return 1;
  }

  if (achados.length === 0) {
    console.log(
      `sonda-edge-nova: ✓ toda edge nascida nesta fatia tem a decisão de instrumentação TOMADA ` +
        `(base ${base.slice(0, 9)}).`,
    );
    return 0;
  }

  for (const a of achados) console.error(formatarAchado(a));
  console.error(`\nsonda-edge-nova: ${achados.length} edge(s) nova(s) com a decisão em aberto.`);
  return 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
