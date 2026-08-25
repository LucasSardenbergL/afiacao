#!/usr/bin/env bun
/**
 * sonda-versao-bump-gate.ts — "mudou a edge? então o marcador tem de mudar junto".
 * ============================================================================================
 *
 * ## O buraco que ele tapa
 *
 * ~30 edges de `supabase/functions/` carregam um `versao.ts` que exporta `VERSAO`, respondido por
 * `{"probe":true}`. Esse marcador é a ÚNICA prova de qual bundle está em produção — o Lovable
 * Cloud não dá N2 (não existe Access Token para o founder gerar), então a escada de
 * `lovable-deploy-verify` morre no N1 e a sonda é o degrau final.
 *
 * Só que o marcador só prova alguma coisa se for bumpado ANTES do deploy: marcador IGUAL na `main`
 * e em prod responde a mesma string tendo o deploy acontecido ou não.
 *
 * MEDIDO, não suposto: o #1930 escreveu `v1.0-prompt-invertido-cacheado` na `analyze-unified-order`
 * e o #1938 alterou a edge sem bumpar. Em 2026-08-25 a sonda de prod respondeu esse mesmo valor
 * (request_id 59657) — provava "o bundle é ≥ #1930" e NADA MAIS. O #1970 bumpou para
 * `v1.1-corpo-tipado` e travou a REGRESSÃO num gate de texto do
 * `_shared/sonda-versao-contrato_test.ts`; a OMISSÃO — que é o que de fato aconteceu — continuava
 * descoberta, porque nenhum gate que lê só o estado ATUAL do repo sabe se o valor mudou.
 *
 * Este gate sabe, porque olha o DIFF: é a única fonte de "mudou" que existe.
 *
 * ## A régua, e o denominador que a escolheu
 *
 * Uma edge "mudou" quando um arquivo do seu CORPO SERVIDO difere entre a base e o HEAD depois de
 * `removerComentarios` + descarte de indentação e linha em branco. Ficam FORA:
 *
 *   · `*_test.ts` / `*.test.ts` — o bundle é byte-idêntico com o teste mudado;
 *   · o próprio `versao.ts` — ele É o marcador, e é 90% prosa. (O commit que deu `respostaSonda`
 *     às 16 edges teria exigido 16 bumps de uma vez; e a mudança que ele fez é auto-evidente na
 *     resposta da própria sonda, que passou a dizer qual edge respondeu.)
 *   · comentário e formatação — gate que grita em prosa é gate que alguém afrouxa.
 *
 * Medido contra as 414 fatias da `main` anteriores a 2026-08-25, com o próprio gate decidindo:
 * **26 tocam uma das 32 edges instrumentadas** (com marcador já presente na fatia) e esta régua
 * reprovaria **6** — o #1938 (`e70bfa050`) entre elas, que é o controle positivo, e nenhuma
 * reprovação sem mudança real de `index.ts`. Régua sem o filtro de teste reprovaria 7; a diferença
 * é uma fatia que só mexeu em `*_test.ts`.
 *
 * ⚠️ Reconciliação com `docs/historico/sonda-marcador-congelado.md`, que mede a MESMA janela e
 * reporta ~68: lá o denominador são os **94** diretórios de edge do repo; aqui são as **32**
 * instrumentadas, que é o universo onde este gate pode agir. Na mesma medição, 72 fatias tocam
 * alguma das 94 e 54 tocam `_shared/` (o doc reporta 55). Números diferentes, perguntas diferentes.
 *
 * ## O que fica DE FORA de propósito: `supabase/functions/_shared/`
 *
 * Uma mudança em `_shared/paginate.ts` altera o comportamento de toda edge que o empacota — foi
 * literalmente o #1901, que congelou a `recommend`. Incluir `_shared/` no gate parece óbvio e é a
 * decisão errada, porque foi MEDIDO: nas mesmas fatias, 31 tocam `_shared/*.ts` não-teste, e
 * cobri-las produziria 290 pares (edge, fatia) em 25 delas — cerca de 12 marcadores a bumpar por
 * PR, num repo
 * onde a maior parte dessas mudanças (um helper de CORS, o stripper de comentários) não altera
 * comportamento de edge nenhuma. Precisão > recall: gate que grita 12× por PR treina a ignorar.
 * O que cobre essa metade hoje é humano + o gate `nenhuma edge que serve o paginate.ts fica SEM
 * prova de deploy`, no `_shared/sonda-versao-contrato_test.ts`.
 *
 * ## Por que um script e não um teste
 *
 * Precisa do DIFF. O vitest lê edge como TEXTO mas não tem base de comparação; o `test:edges` roda
 * `deno test --no-remote` e não pode nem abrir o git. Só um script chamado pelo `validate` alcança
 * o merge-base — e é por isso que o checkout do job carrega `fetch-depth: 0`.
 *
 * ## Fail-CLOSED
 *
 * Sem base determinável, ou com `versao.ts` cujo `VERSAO` não é legível, o gate REPROVA. Um gate
 * que degrada para verde quando não consegue medir é indistinguível de verde por mérito — a
 * assinatura de falha mais cara que existe num fiscal.
 *
 * Uso:
 *   bun run sonda:bump                       # base = merge-base com origin/main (ou GITHUB_BASE_REF)
 *   bun scripts/sonda-versao-bump-gate.ts --base <rev> [--head <rev>]
 *   SONDA_BASE=<rev> bun run sonda:bump      # mesma coisa, por env
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

/** raiz das edge functions, relativa à raiz do repo */
export const RAIZ_EDGES = 'supabase/functions';

/** o arquivo que carrega o marcador */
const ARQ_MARCADOR = 'versao.ts';

/** extensões que viram bundle servido */
const EXT_CORPO = ['.ts', '.tsx', '.js', '.mjs'];

export interface ArquivoCorpo {
  /** caminho relativo à raiz do repo */
  caminho: string;
  /** fonte na BASE, ou null quando o arquivo ainda não existia */
  base: string | null;
  /** fonte no HEAD, ou null quando o arquivo foi removido */
  head: string | null;
}

export interface EstadoEdge {
  edge: string;
  /** `VERSAO` na BASE; null quando a edge ainda não era instrumentada */
  versaoBase: string | null;
  /** `VERSAO` no HEAD; null quando o marcador ficou ilegível */
  versaoHead: string | null;
  corpo: ArquivoCorpo[];
}

export type MotivoAchado = 'sem-bump' | 'marcador-ilegivel';

export interface Achado {
  edge: string;
  /** o marcador que o gate leu — o congelado, no caso do `sem-bump` */
  versao: string;
  motivo: MotivoAchado;
  /** arquivos do corpo cuja mudança sobreviveu à limpeza */
  arquivos: string[];
}

/**
 * O caminho pertence ao CORPO SERVIDO desta edge?
 *
 * A fronteira é de SEGMENTO, não de string — o prefixo termina em `/`, então `omie-sync` não
 * engole `omie-sync-estoque`. Este repo tem os dois, logo o falso-positivo seria permanente.
 */
export function contaComoCorpo(caminho: string, edge: string): boolean {
  const prefixo = `${RAIZ_EDGES}/${edge}/`;
  if (!caminho.startsWith(prefixo)) return false;
  const resto = caminho.slice(prefixo.length);
  if (resto === ARQ_MARCADOR) return false;
  if (/(?:_test|\.test)\.[cm]?[jt]sx?$/.test(resto)) return false;
  return EXT_CORPO.some((ext) => resto.endsWith(ext));
}

/**
 * Lê o literal de `export const VERSAO`.
 *
 * Passa pelo stripper COMPARTILHADO antes de medir: um `VERSAO` citado dentro do comentário (e o
 * `versao.ts` deste repo é quase todo comentário, inclusive citando marcadores antigos) não pode
 * ser confundido com o export real.
 */
export function extrairVersao(fonte: string): string | null {
  const limpo = removerComentarios(fonte);
  const m = limpo.match(/export\s+const\s+VERSAO\s*(?::[^=]+)?=\s*(["'])(.*?)\1/);
  return m ? m[2] : null;
}

/**
 * Forma comparável de uma fonte: sem comentário, sem indentação, sem linha em branco.
 *
 * O stripper é o COMPARTILHADO (`@/lib/gates/limpeza-fonte`), que entende string, template e regex
 * literal — nunca uma regex local. O caso que obriga isso está no cabeçalho dele: o mimetype
 * coringa do header `Accept` das edges Sayerlack carrega uma abertura de comentário DENTRO de
 * string, e uma regex ingênua a pareia com o próximo fechamento real, apagando o miolo do arquivo
 * ANTES da medição — 1.041 de 1.226 linhas, no caso medido.
 */
export function normalizarFonte(fonte: string): string {
  return removerComentarios(fonte)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('\n');
}

function normalizarOuNull(fonte: string | null): string | null {
  return fonte === null ? null : normalizarFonte(fonte);
}

/**
 * Núcleo puro do gate: recebe o estado das edges tocadas, devolve o que reprova.
 *
 * O `contaComoCorpo` é reaplicado aqui de propósito, mesmo com `coletarEstado` já filtrando: o
 * filtro é o que separa "mudou o bundle" de "mudou um teste", e deixá-lo só no chamador significa
 * que um chamador futuro (uma auditoria, um harness) monta o estado sem ele e o gate passa a
 * gritar por `*_test.ts`. Gate que grita errado treina a ignorar — a regra mora no núcleo.
 */
export function auditarBump(edges: EstadoEdge[]): Achado[] {
  const achados: Achado[] = [];
  for (const e of edges) {
    const arquivos = e.corpo
      .filter((a) => contaComoCorpo(a.caminho, e.edge))
      .filter((a) => normalizarOuNull(a.base) !== normalizarOuNull(a.head))
      .map((a) => a.caminho)
      .sort();
    if (arquivos.length === 0) continue;

    // Edge que NASCE instrumentada nesta fatia: o marcador inicial já nomeia o que ela é.
    if (e.versaoBase === null) continue;

    if (e.versaoHead === null) {
      achados.push({ edge: e.edge, versao: e.versaoBase, motivo: 'marcador-ilegivel', arquivos });
      continue;
    }
    if (e.versaoHead !== e.versaoBase) continue;

    achados.push({ edge: e.edge, versao: e.versaoHead, motivo: 'sem-bump', arquivos });
  }
  return achados;
}

// ─── I/O: git ────────────────────────────────────────────────────────────────────────────────

function git(args: string[]): { ok: boolean; saida: string } {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, saida: (r.stdout ?? '').replace(/\n$/, '') };
}

/**
 * Resolve a BASE contra a qual medir, na ordem: `--base`/`SONDA_BASE` → merge-base com a branch
 * base do PR → merge-base com `origin/main` → `main`. Devolve null se nada resolver — e aí o gate
 * reprova, porque não medir não é o mesmo que estar em ordem.
 */
export function resolverBase(explicita?: string): string | null {
  if (explicita) {
    const r = git(['rev-parse', '--verify', `${explicita}^{commit}`]);
    return r.ok ? r.saida : null;
  }
  const candidatos = [
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null,
    'origin/main',
    'main',
  ].filter((c): c is string => c !== null);
  for (const ref of candidatos) {
    const r = git(['merge-base', ref, 'HEAD']);
    if (r.ok && r.saida) return r.saida;
  }
  return null;
}

function lerNaRev(rev: string, caminho: string): string | null {
  const r = spawnSync('git', ['show', `${rev}:${caminho}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 ? (r.stdout ?? '') : null;
}

function lerNoHead(headRev: string | null, caminho: string): string | null {
  if (headRev) return lerNaRev(headRev, caminho);
  return existsSync(caminho) ? readFileSync(caminho, 'utf8') : null;
}

/** Coleta o estado das edges instrumentadas que a fatia tocou. */
export function coletarEstado(base: string, headRev: string | null): EstadoEdge[] {
  const args = ['diff', '--name-only', base];
  if (headRev) args.push(headRev);
  args.push('--', RAIZ_EDGES);
  const { saida } = git(args);
  const tocados = saida.split('\n').filter((l) => l !== '');

  const porEdge = new Map<string, string[]>();
  for (const caminho of tocados) {
    const m = caminho.match(new RegExp(`^${RAIZ_EDGES}/([^/]+)/`));
    if (!m || m[1] === '_shared') continue;
    if (!contaComoCorpo(caminho, m[1])) continue;
    const lista = porEdge.get(m[1]) ?? [];
    lista.push(caminho);
    porEdge.set(m[1], lista);
  }

  const estados: EstadoEdge[] = [];
  for (const [edge, arquivos] of [...porEdge].sort()) {
    const marcador = `${RAIZ_EDGES}/${edge}/${ARQ_MARCADOR}`;
    const fonteHead = lerNoHead(headRev, marcador);
    // Edge sem `versao.ts` no HEAD não é instrumentada — quem cobre essa classe é o gate
    // `nenhuma edge que serve o paginate.ts fica SEM prova de deploy`, no contrato da sonda.
    if (fonteHead === null) continue;
    const fonteBase = lerNaRev(base, marcador);
    estados.push({
      edge,
      versaoBase: fonteBase === null ? null : extrairVersao(fonteBase),
      versaoHead: extrairVersao(fonteHead),
      corpo: arquivos.map((caminho) => ({
        caminho,
        base: lerNaRev(base, caminho),
        head: lerNoHead(headRev, caminho),
      })),
    });
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
      'sonda-bump-gate: ✗ não consegui determinar a BASE do diff (tentei ' +
        `${process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}, ` : ''}` +
        'origin/main, main).\n' +
        '  No CI: o checkout do job precisa de `fetch-depth: 0`.\n' +
        '  Local: `git fetch origin main`, ou passe `--base <rev>`.\n' +
        '  O gate REPROVA em vez de degradar — não medir não é o mesmo que estar em ordem.',
    );
    return 1;
  }

  const achados = auditarBump(coletarEstado(base, headRev));
  if (achados.length === 0) {
    console.log(
      `sonda-bump-gate: ✓ toda edge instrumentada alterada nesta fatia bumpou o VERSAO (base ${base.slice(0, 9)}).`,
    );
    return 0;
  }

  for (const a of achados) {
    const arq = a.arquivos.join(', ');
    if (a.motivo === 'marcador-ilegivel') {
      console.error(
        `✗ ${a.edge}: o corpo mudou (${arq}) e não consegui ler \`export const VERSAO\` em ` +
          `${RAIZ_EDGES}/${a.edge}/${ARQ_MARCADOR}. Sem marcador legível a sonda não prova bundle nenhum.`,
      );
      continue;
    }
    console.error(
      `✗ ${a.edge}: o corpo mudou (${arq}) e o marcador continua \`${a.versao}\` — o mesmo da base.\n` +
        `  A sonda vai responder a MESMA string tendo esta fatia subido ou não, e o Lovable não dá\n` +
        `  outra prova de qual bundle está no ar. Bumpe \`VERSAO\` em ${RAIZ_EDGES}/${a.edge}/${ARQ_MARCADOR}\n` +
        '  nomeando a FATIA desta entrega (formato `vN.N-slug`), ANTES do deploy.',
    );
  }
  console.error(`\nsonda-bump-gate: ${achados.length} edge(s) alterada(s) sem bump do marcador.`);
  return 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
