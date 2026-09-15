#!/usr/bin/env bun
/**
 * ordem-entre-edges-declaracao.ts — o gate da declaração de ordem entre edges no CORPO do PR.
 * ============================================================================================
 *
 * A fiação: lê o corpo do PR, o diff base..HEAD e os manifestos pelo git, e entrega ao núcleo puro
 * (`scripts/lib/ordem-entre-edges-declaracao.ts`, onde moram a regra e o porquê). Roda no workflow
 * próprio `.github/workflows/ordem-entre-edges.yml`, que existe porque o corpo muda sem push.
 *
 * Uso:
 *   bun run ordem:declaracao -- --evento "$GITHUB_EVENT_PATH"        # CI
 *   bun run ordem:declaracao -- --pr 2510                             # local, corpo pela API
 *   bun run ordem:declaracao -- --corpo-arquivo corpo.md [--base <rev>] [--head <rev>]
 *
 * Exit: 0 aprovado · 1 achado (a linha começa pela marca `ORDEM_*`) · 2 não consegui medir
 * (`ORDEM_MEDICAO_FALHOU`). O 2 fica vermelho igual ao 1 — não medir não é estar em ordem —, mas diz
 * que a falha é da medição, não do PR.
 *
 * O corpo vem do payload do evento, sem rede: cada edição dispara um run novo com o corpo novo, e a
 * API do GitHub fora do ar não derruba o gate de todo PR (o incidente de 2026-07-16 do
 * `bun-pin-gate-check.ts`). A exceção é o re-run, que reusa o payload do evento ORIGINAL: aí o corpo
 * é relido pela API, e falha na releitura é exit 2 — nunca o corpo velho.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mensagemDeErro } from '@/lib/erro-mensagem';

import { caminhoDoManifesto, lerManifesto } from './lib/ordem-entre-edges';
import { formatarVeredito, julgar, medirPopulacao } from './lib/ordem-entre-edges-declaracao';
import { git, lerNaRev, RAIZ_EDGES, resolverBase } from './sonda-versao-bump-gate';

type Fonte = { tipo: 'evento'; caminho: string } | { tipo: 'arquivo'; caminho: string } | { tipo: 'pr'; numero: number };

interface Args {
  fonte: Fonte;
  base?: string;
  head?: string;
}

interface EntradaDiff {
  status: string;
  caminho: string;
}

/** Roda o `gh` — injetável para o teste provar a releitura sem rede. */
export type Rodar = (args: string[]) => { ok: boolean; saida: string };

type Ambiente = Readonly<Record<string, string | undefined>>;

interface Resultado {
  codigo: 0 | 1 | 2;
  saida: string;
}

export const MARCA_MEDICAO_FALHOU = 'ORDEM_MEDICAO_FALHOU';

const USO =
  'uso: bun run ordem:declaracao -- (--evento <arquivo> | --pr <nº> | --corpo-arquivo <arquivo>) [--base <rev>] [--head <rev>]';
const FLAGS = new Set(['--evento', '--pr', '--corpo-arquivo', '--base', '--head']);
const JQ_CORPO = '.body // ""';
/** Com `--no-renames` o diff entre dois commits só tem estes; outro status é pareamento desalinhado. */
const STATUS_DIFF = /^[ADMT]$/;

const gh: Rodar = (args) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, saida: (r.stdout ?? '').replace(/\n$/, '') };
};

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function lerArgs(argv: readonly string[]): Args | { erro: string } {
  const resto = argv.filter((a) => a !== '--');
  const valores = new Map<string, string>();
  for (let i = 0; i < resto.length; i += 2) {
    const [flag, valor] = [resto[i], resto[i + 1]];
    if (!FLAGS.has(flag)) return { erro: `argumento desconhecido: ${flag}` };
    if (valor === undefined || valor.startsWith('--')) return { erro: `${flag} precisa de um valor` };
    if (valores.has(flag)) return { erro: `${flag} repetido` };
    valores.set(flag, valor);
  }
  const fontes: Fonte[] = [];
  const evento = valores.get('--evento');
  if (evento !== undefined) fontes.push({ tipo: 'evento', caminho: evento });
  const arquivo = valores.get('--corpo-arquivo');
  if (arquivo !== undefined) fontes.push({ tipo: 'arquivo', caminho: arquivo });
  const pr = valores.get('--pr');
  if (pr !== undefined) {
    if (!/^[1-9]\d*$/.test(pr)) return { erro: `--pr precisa do número do PR, não ${JSON.stringify(pr)}` };
    fontes.push({ tipo: 'pr', numero: Number(pr) });
  }
  if (fontes.length !== 1) return { erro: 'passe exatamente uma fonte de corpo: --evento, --pr ou --corpo-arquivo' };
  const args: Args = { fonte: fontes[0] };
  const base = valores.get('--base');
  if (base !== undefined) args.base = base;
  const head = valores.get('--head');
  if (head !== undefined) args.head = head;
  return args;
}

/** Corpo vazio por ERRO não é corpo vazio por mérito: fora da população, o vazio aprovaria por cegueira. */
export function corpoDoEvento(evento: unknown): { corpo: string; numero: number } | { erro: string } {
  const pr = ehObjeto(evento) ? evento.pull_request : undefined;
  if (!ehObjeto(pr)) return { erro: 'o evento não tem `pull_request` — este gate só roda em pull_request' };
  if (typeof pr.number !== 'number' || !Number.isInteger(pr.number)) return { erro: 'o evento não traz `pull_request.number`' };
  if (pr.body !== null && typeof pr.body !== 'string') return { erro: 'o evento não traz `pull_request.body`' };
  return { corpo: pr.body ?? '', numero: pr.number };
}

function relerCorpo(repo: string, numero: number, rodarGh: Rodar): { corpo: string } | { erro: string } {
  const r = rodarGh(['api', `${repo}/pulls/${numero}`, '--jq', JQ_CORPO]);
  return r.ok ? { corpo: r.saida } : { erro: `não consegui reler o corpo do PR #${numero} pela API do GitHub` };
}

export function obterCorpo(fonte: Fonte, ambiente: Ambiente, rodarGh: Rodar): { corpo: string } | { erro: string } {
  if (fonte.tipo === 'pr') return relerCorpo('repos/{owner}/{repo}', fonte.numero, rodarGh);
  let texto: string;
  try {
    texto = readFileSync(fonte.caminho, 'utf8');
  } catch (e) {
    return { erro: `não li ${fonte.caminho}: ${mensagemDeErro(e) ?? 'ilegível'}` };
  }
  if (fonte.tipo === 'arquivo') return { corpo: texto };

  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch (e) {
    return { erro: `o evento em ${fonte.caminho} não é JSON: ${mensagemDeErro(e) ?? 'ilegível'}` };
  }
  const doEvento = corpoDoEvento(bruto);
  if ('erro' in doEvento) return doEvento;
  if (Number(ambiente.GITHUB_RUN_ATTEMPT ?? '1') <= 1) return { corpo: doEvento.corpo };
  return relerCorpo(`repos/${ambiente.GITHUB_REPOSITORY ?? '{owner}/{repo}'}`, doEvento.numero, rodarGh);
}

/** `git diff --name-status -z`: status e caminho alternados, separados por NUL. */
export function lerDiffNameStatus(saida: string): EntradaDiff[] {
  const campos = saida.split('\0');
  if (campos[campos.length - 1] === '') campos.pop();
  const entradas: EntradaDiff[] = [];
  for (let i = 0; i < campos.length; i += 2) {
    const [status, caminho] = [campos[i], campos[i + 1]];
    if (!STATUS_DIFF.test(status)) throw new Error(`status inesperado no git diff: ${JSON.stringify(status)}`);
    if (caminho === undefined) throw new Error('saída do git diff truncada: status sem caminho');
    entradas.push({ status, caminho });
  }
  return entradas;
}

/** Edge é pasta com `index.ts` no 1º nível; manifesto é o `deploy-ordem.json` de qualquer pasta. */
export function inventariar(caminhos: readonly string[]): { edges: Set<string>; manifestos: string[] } {
  const edges = new Set<string>();
  const manifestos = new Set<string>();
  for (const c of caminhos) {
    if (!c.startsWith(`${RAIZ_EDGES}/`)) continue;
    const partes = c.slice(RAIZ_EDGES.length + 1).split('/');
    if (partes.length !== 2) continue;
    const [pasta, arquivo] = partes;
    if (arquivo === 'index.ts') edges.add(pasta);
    if (c === caminhoDoManifesto(pasta)) manifestos.add(pasta);
  }
  return { edges, manifestos: [...manifestos].sort() };
}

/** Controle positivo do inventário: lista vazia por ERRO não é lista vazia por mérito. */
export function conferirInventario(inventario: readonly string[], devemEstar: readonly string[], rotulo: string): string | null {
  if (inventariar(inventario).edges.size === 0) {
    return `o inventário do ${rotulo} não tem nenhuma edge (${RAIZ_EDGES}/<edge>/index.ts)`;
  }
  const presentes = new Set(inventario);
  const faltando = devemEstar.filter((c) => !presentes.has(c));
  if (faltando.length > 0) {
    return `o inventário do ${rotulo} não tem ${faltando.length} caminho(s) que o diff diz existir: ${faltando.slice(0, 5).join(', ')}`;
  }
  return null;
}

const falhou = (motivo: string): Resultado => ({
  codigo: 2,
  saida: `${MARCA_MEDICAO_FALHOU}: ${motivo}\n  Não é veredito sobre o PR: o gate não conseguiu medir e fica vermelho por segurança.`,
});

function listar(rev: string): string[] | null {
  const r = git(['ls-tree', '-r', '--name-only', '-z', rev, '--', `${RAIZ_EDGES}/`]);
  return r.ok ? r.saida.split('\0').filter((c) => c !== '') : null;
}

type Lidos = { pares: Map<string, Set<string>>; ilegiveis: Map<string, string> };

function lerManifestos(rev: string, edges: readonly string[]): Lidos | { erro: string } {
  const lidos: Lidos = { pares: new Map(), ilegiveis: new Map() };
  for (const edge of edges) {
    const texto = lerNaRev(rev, caminhoDoManifesto(edge));
    if (texto === null) return { erro: `${caminhoDoManifesto(edge)} está no inventário de ${rev} e o git show não o leu` };
    try {
      lidos.pares.set(edge, new Set(lerManifesto(edge, texto).depoisDe.map((d) => d.edge)));
    } catch (e) {
      lidos.ilegiveis.set(edge, mensagemDeErro(e) ?? 'ilegível');
    }
  }
  return lidos;
}

export function executar(argv: readonly string[], ambiente: Ambiente = process.env, rodarGh: Rodar = gh): Resultado {
  const args = lerArgs(argv);
  if ('erro' in args) return falhou(`${args.erro}\n  ${USO}`);
  const lido = obterCorpo(args.fonte, ambiente, rodarGh);
  if ('erro' in lido) return falhou(lido.erro);

  const base = resolverBase(args.base);
  if (base === null) return falhou(`não resolvi a base ${args.base ?? '(merge-base com a main)'}`);
  const head = git(['rev-parse', '--verify', `${args.head ?? 'HEAD'}^{commit}`]);
  if (!head.ok) return falhou(`não resolvi o head ${args.head ?? 'HEAD'}`);

  const diff = git(['diff', '--name-status', '--no-renames', '-z', base, head.saida, '--', `${RAIZ_EDGES}/`]);
  if (!diff.ok) return falhou(`git diff ${base}..${head.saida} falhou`);
  let entradas: EntradaDiff[];
  try {
    entradas = lerDiffNameStatus(diff.saida);
  } catch (e) {
    return falhou(mensagemDeErro(e) ?? 'saída do git diff ilegível');
  }

  const noHead = listar(head.saida);
  const naBase = listar(base);
  if (noHead === null || naBase === null) return falhou('git ls-tree falhou');
  const controle =
    conferirInventario(noHead, entradas.filter((x) => x.status !== 'D').map((x) => x.caminho), 'HEAD') ??
    conferirInventario(naBase, entradas.filter((x) => x.status !== 'A').map((x) => x.caminho), 'base');
  if (controle !== null) return falhou(controle);

  const tocados = entradas.map((x) => x.caminho);
  const invHead = inventariar(noHead);
  const lidosHead = lerManifestos(head.saida, invHead.manifestos);
  if ('erro' in lidosHead) return falhou(lidosHead.erro);
  const naBaseTambem = new Set(inventariar(naBase).manifestos);
  const tocadosNaBase = medirPopulacao(tocados, invHead.edges).manifestosTocados.filter((e) => naBaseTambem.has(e));
  const lidosBase = lerManifestos(base, tocadosNaBase);
  if ('erro' in lidosBase) return falhou(lidosBase.erro);

  const v = julgar({
    corpo: lido.corpo,
    tocados,
    edgesNoHead: invHead.edges,
    paresNoHead: lidosHead.pares,
    paresNaBase: lidosBase.pares,
    ilegiveisNoHead: lidosHead.ilegiveis,
    ilegiveisNaBase: lidosBase.ilegiveis,
  });
  return { codigo: v.aprovado ? 0 : 1, saida: formatarVeredito(v) };
}

export function main(argv: string[]): number {
  const r = executar(argv);
  if (r.codigo === 0) console.log(r.saida);
  else console.error(r.saida);
  return r.codigo;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
