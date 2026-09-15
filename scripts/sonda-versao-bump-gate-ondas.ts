/**
 * # As ondas reais do `sonda:bump`, congeladas — gerador (`--gerar`) e verificador (`--check`)
 *
 * ## Por que existe (#2474)
 *
 * O #2470 provou a fatia declarada do relé contra a HISTÓRIA: 4 squashes da `main` em que a
 * allowlist do cron mudou com o marcador do relé congelado, e a onda 1 (que bumpou) de controle. O
 * teste chamava `coletarEstado(sha^, sha)` e herdava o CLONE: no checkout nu do `mutation-check`
 * (profundidade 1) os commits não existem, os 5 casos lançavam e a baseline do contrato
 * `sonda-versao-bump-gate.mut` caiu na `main`. É a classe do #2227
 * (`docs/historico/teste-que-afirma-o-checkout.md`): histórico é propriedade do clone, não do código.
 *
 * ## O que fica congelado — as ENTRADAS que o gate leu, nunca as saídas
 *
 * - `tocados`: a saída inteira do MESMO `git diff --name-only base head -- supabase/functions` do
 *   `coletarEstado`, inclusive o que o gate descarta (teste, markdown, `_shared/` comum).
 * - `versao.ts` e fatia declarada (`FATIAS_EM_SHARED`): o blob INTEIRO. É o que dá dente ao
 *   `extrairVersao` e à projeção sobre arquivos que ninguém escreveu para teste: um `extrairVersao`
 *   que exigisse `VERSAO` no fim do arquivo passa em todo exemplo sintético e cai nas 4 ondas,
 *   porque o `versao.ts` real tem export depois do marcador (mutação no `.mut`).
 * - corpo: o token `sha256_<hex>` da fonte NORMALIZADA. Do corpo o gate só pergunta "mudou?", e o
 *   token preserva exatamente essa igualdade sem carregar ~1,5 MB de edge. Ausente (`null`) nunca
 *   vira token e arquivo vazio vira token — os dois continuam distintos.
 *
 * Ausência é `blob: null` dita por um `git ls-tree` que TERMINOU sem a entrada. Git que falha lança:
 * erro de leitura nunca vira ausência.
 *
 * ## Quem confere o quê
 *
 * A suíte (`sonda-versao-bump-gate.test.ts`) consome o congelado SEM git: o leitor congelado lança
 * em revisão ou caminho que não registrou, cada blob integral bate com o próprio id de git e cada
 * token sobrevive à renormalização do gate. Os casos e os resultados esperados moram FIXOS lá —
 * nunca derivados daqui.
 *
 * O `--check` precisa do histórico e confere o congelado contra o git, sem escrever: sha completo,
 * pai ÚNICO e exato, `tocados` inteiro, revisão × caminho × blob, conteúdo igual ao que o `lerNaRev`
 * do gate devolve, token sem colisão no corpus, e o ESTADO montado com o congelado igual ao do
 * `coletarEstado` real — edges, marcadores, caminhos e a decisão "mudou?" do núcleo, arquivo por
 * arquivo. Conferir só os achados não bastaria: um congelado que perdesse as outras edges daria os
 * mesmos 5 resultados.
 *
 * O congelado não carimba a revisão do normalizador: o `--check` regenera com o normalizador ATUAL
 * e compara byte a byte, então token que mudaria com ele sai como divergência — e a revisão que
 * produziu o arquivo é o commit que o tocou.
 *
 * A necessidade de histórico mora AQUI e só aqui — nunca como pré-condição, geração automática ou
 * skip da suíte.
 *
 * Uso (na raiz de um clone COMPLETO):
 *   bun run sonda:bump-ondas -- --check   # 0 confere · 1 diverge · 2 uso · 3 não consegui verificar
 *   bun run sonda:bump-ondas -- --gerar   # reescreve o congelado; revise o diff antes de commitar
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import {
  auditarBump,
  coletarEstado,
  comparavel,
  FATIAS_EM_SHARED,
  lerNaRev,
  montarEstado,
  normalizarFonte,
  RAIZ_EDGES,
  type EstadoEdge,
  type LeitorFonte,
} from './sonda-versao-bump-gate';

/** Os squashes da `main` que o #2470 mediu: a onda 1 bumpou o relé; as ondas 2 a 5, não. Imutáveis. */
export const FATIAS_CONGELADAS = ['54679dc35', '89887025b', 'd96b69f06', 'a73641e9c', 'f4578bbff'] as const;

/** Onde o congelado mora, relativo à raiz do repo. */
export const ARQ_ONDAS = 'scripts/fixtures/sonda-versao-bump-gate-ondas.json';

/** O mesmo arquivo ancorado NESTE módulo — o teste de integração troca o `cwd` do processo. */
const ARQ_ONDAS_ABS = fileURLToPath(new URL('./fixtures/sonda-versao-bump-gate-ondas.json', import.meta.url));

const FORMATO = 'sonda-versao-bump-gate-ondas/1';
const RE_SHA = /^[0-9a-f]{40}$/;
const RE_TOKEN = /^sha256_[0-9a-f]{64}$/;
const RE_MARCADOR = new RegExp(`^${RAIZ_EDGES}/[^/]+/versao\\.ts$`);

export interface LeituraCongelada {
  rev: 'base' | 'head';
  caminho: string;
  /** id do blob naquela árvore; `null` = caminho AUSENTE, dito por um `git ls-tree` que terminou */
  blob: string | null;
  /** só em leitura de CORPO presente: `sha256_<hex>` da fonte normalizada */
  corpo?: string;
}

export interface OndaCongelada {
  /** sha completo do squash */
  head: string;
  /** sha completo do ÚNICO pai */
  base: string;
  tocados: string[];
  leituras: LeituraCongelada[];
}

export interface ArquivoOndas {
  formato: typeof FORMATO;
  ondas: OndaCongelada[];
  /** id do blob → conteúdo INTEGRAL (marcadores e fatias declaradas) */
  blobs: Record<string, string>;
}

// ─── Puro: o que a suíte usa, sem git ────────────────────────────────────────────────────────

/** Token de corpo: sha256 da fonte normalizada — a igualdade que o núcleo do gate mede no corpo. */
export function tokenDeCorpo(fonte: string): string {
  return `sha256_${createHash('sha256').update(normalizarFonte(fonte), 'utf8').digest('hex')}`;
}

/** O id que o git dá a um blob (sha1 de `blob <bytes>\0` + conteúdo): confere conteúdo × id SEM git. */
export function idDeBlob(conteudo: string): string {
  const bytes = Buffer.from(conteudo, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Leitura INTEGRAL: marcador de edge ou fatia declarada em `_shared/`. O resto é corpo (token). */
export function leituraIntegral(caminho: string): boolean {
  return RE_MARCADOR.test(caminho) || FATIAS_EM_SHARED.some((f) => f.arquivo === caminho);
}

function falhar(msg: string): never {
  throw new Error(`ONDAS-CONGELADAS: ${msg}`);
}

const temChave = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function objeto(
  v: unknown,
  onde: string,
  chaves: readonly string[],
  opcionais: readonly string[] = [],
): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) falhar(`${onde} não é objeto`);
  const sobra = Object.keys(v).filter((k) => !chaves.includes(k) && !opcionais.includes(k));
  const falta = chaves.filter((k) => !temChave(v, k));
  if (sobra.length > 0 || falta.length > 0) {
    falhar(`${onde}: chave(s) sobrando [${sobra.join(', ')}], faltando [${falta.join(', ')}]`);
  }
  return v as Record<string, unknown>;
}

function texto(v: unknown, onde: string, re?: RegExp): string {
  if (typeof v !== 'string' || (re !== undefined && !re.test(v))) falhar(`${onde} inválido: ${JSON.stringify(v)}`);
  return v;
}

function lista(v: unknown, onde: string): unknown[] {
  if (!Array.isArray(v)) falhar(`${onde} não é lista`);
  return v;
}

/** Valida a FORMA do congelado — estrita: chave sobrando é tão suspeita quanto chave faltando. */
export function validarArquivoOndas(bruto: unknown): ArquivoOndas {
  const raiz = objeto(bruto, 'raiz', ['formato', 'ondas', 'blobs']);
  if (raiz.formato !== FORMATO) falhar(`formato ${JSON.stringify(raiz.formato)}, esperado ${FORMATO}`);
  const blobsBrutos = raiz.blobs;
  if (typeof blobsBrutos !== 'object' || blobsBrutos === null || Array.isArray(blobsBrutos)) {
    falhar('blobs não é objeto');
  }
  const blobs: Record<string, string> = {};
  for (const [id, conteudo] of Object.entries(blobsBrutos)) {
    blobs[texto(id, 'id de blob', RE_SHA)] = texto(conteudo, `blobs[${id}]`);
  }

  const usados = new Set<string>();
  const ondas = lista(raiz.ondas, 'ondas').map((bruta, i): OndaCongelada => {
    const onde = `ondas[${i}]`;
    const o = objeto(bruta, onde, ['head', 'base', 'tocados', 'leituras']);
    const head = texto(o.head, `${onde}.head`, RE_SHA);
    const base = texto(o.base, `${onde}.base`, RE_SHA);
    if (head === base) falhar(`${onde}: base igual ao head`);
    const tocados = lista(o.tocados, `${onde}.tocados`).map((t, j) => texto(t, `${onde}.tocados[${j}]`));
    const vistas = new Set<string>();
    const leituras = lista(o.leituras, `${onde}.leituras`).map((bl, j): LeituraCongelada => {
      const ondeL = `${onde}.leituras[${j}]`;
      const l = objeto(bl, ondeL, ['rev', 'caminho', 'blob'], ['corpo']);
      const rev = l.rev;
      if (rev !== 'base' && rev !== 'head') falhar(`${ondeL}.rev inválida: ${JSON.stringify(rev)}`);
      const caminho = texto(l.caminho, `${ondeL}.caminho`);
      if (vistas.has(`${rev}\0${caminho}`)) falhar(`${ondeL}: leitura duplicada`);
      vistas.add(`${rev}\0${caminho}`);
      const blob = l.blob === null ? null : texto(l.blob, `${ondeL}.blob`, RE_SHA);
      if (blob === null || leituraIntegral(caminho)) {
        if (temChave(l, 'corpo')) falhar(`${ondeL}: só leitura de corpo PRESENTE carrega token`);
        if (blob !== null) {
          if (!temChave(blobs, blob)) falhar(`${ondeL}: blob ${blob} sem conteúdo`);
          usados.add(blob);
        }
        return { rev, caminho, blob };
      }
      return { rev, caminho, blob, corpo: texto(l.corpo, `${ondeL}.corpo`, RE_TOKEN) };
    });
    return { head, base, tocados, leituras };
  });

  const orfaos = Object.keys(blobs).filter((id) => !usados.has(id));
  if (orfaos.length > 0) falhar(`blob(s) sem leitura que os use: ${orfaos.join(', ')}`);
  return { formato: FORMATO, ondas, blobs };
}

export function carregarOndasCongeladas(): ArquivoOndas {
  return validarArquivoOndas(JSON.parse(readFileSync(ARQ_ONDAS_ABS, 'utf8')));
}

export function ondaCongelada(arquivo: ArquivoOndas, curto: string): OndaCongelada {
  const achadas = arquivo.ondas.filter((o) => o.head.startsWith(curto));
  if (achadas.length !== 1) falhar(`${achadas.length} fatia(s) congelada(s) casam \`${curto}\`; esperado exatamente 1`);
  return achadas[0];
}

/**
 * O leitor que a suíte injeta no `montarEstado`. FAIL-CLOSED: `null` só sai de ausência REGISTRADA;
 * revisão que não é a base nem o head da fatia (inclusive `null`, a árvore de trabalho) e caminho
 * que o congelado não registrou LANÇAM. Sem isso, um erro no sha faria toda leitura virar `null` e
 * o controle da onda 1 passaria por cegueira (parecer do Codex, #2474).
 */
export function leitorCongelado(onda: OndaCongelada, blobs: Readonly<Record<string, string>>): LeitorFonte {
  const valores = new Map<string, string | null>();
  for (const l of onda.leituras) {
    let valor: string | null = null;
    if (l.blob !== null) {
      if (l.corpo !== undefined) valor = l.corpo;
      else if (temChave(blobs, l.blob)) valor = blobs[l.blob];
      else falhar(`blob ${l.blob} sem conteúdo (${l.rev}, ${l.caminho})`);
    }
    valores.set(`${l.rev}\0${l.caminho}`, valor);
  }
  const fatia = onda.head.slice(0, 9);
  return (rev, caminho) => {
    const lado = rev === onda.base ? 'base' : rev === onda.head ? 'head' : null;
    if (lado === null) {
      throw new Error(
        `LEITOR-CONGELADO: REVISAO-INESPERADA ${JSON.stringify(rev)} na fatia ${fatia} — só existem a base e o head`,
      );
    }
    const chave = `${lado}\0${caminho}`;
    if (!valores.has(chave)) {
      throw new Error(
        `LEITOR-CONGELADO: LEITURA-FORA-DO-CONGELADO (${lado}, ${caminho}) na fatia ${fatia} — o gate lê o ` +
          'que não foi congelado; regenere com `bun run sonda:bump-ondas -- --gerar` num clone completo',
      );
    }
    return valores.get(chave) as string | null;
  };
}

export function serializarArquivoOndas(arquivo: ArquivoOndas): string {
  return `${JSON.stringify(arquivo, null, 2)}\n`;
}

// ─── Com git: gerar e conferir (clone COMPLETO) ─────────────────────────────────────────────

/** Git que não respondeu ou objeto fora do clone: não é divergência, é NÃO TER VERIFICADO (exit 3). */
class ErroSemVerificar extends Error {}

/** O git contradiz uma promessa do congelado (exit 1). */
class ErroFidelidade extends Error {}

function gitBytes(args: string[]): Buffer {
  const r = spawnSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
  if (r.error !== undefined || r.status !== 0) {
    const detalhe = r.error !== undefined ? r.error.message : r.stderr.toString('utf8').trim();
    throw new ErroSemVerificar(`\`git ${args.join(' ')}\` falhou (status ${String(r.status)}): ${detalhe}`);
  }
  return r.stdout;
}

function gitTexto(args: string[]): string {
  return gitBytes(args).toString('utf8');
}

/**
 * Lê (rev, caminho) direto do objeto. AUSENTE só quando o `ls-tree` TERMINOU sem a entrada; git que
 * falha lança. E exige que o `lerNaRev` do gate devolva exatamente o mesmo — o congelado reproduz o
 * leitor que o gate usa, não um leitor paralelo.
 */
function lerObjeto(rev: string, caminho: string): { blob: string | null; fonte: string | null } {
  const entradas = gitTexto(['ls-tree', '-z', '--full-tree', rev, '--', caminho])
    .split('\0')
    .filter((e) => e !== '');
  let blob: string | null = null;
  let fonte: string | null = null;
  if (entradas.length > 0) {
    const m = entradas.length === 1 ? /^100(?:644|755) blob ([0-9a-f]{40})\t(.*)$/s.exec(entradas[0]) : null;
    if (m === null || m[2] !== caminho) {
      throw new ErroFidelidade(`\`ls-tree ${rev} -- ${caminho}\` devolveu ${JSON.stringify(entradas)}; esperado 1 blob comum`);
    }
    const bytes = gitBytes(['cat-file', 'blob', m[1]]);
    fonte = bytes.toString('utf8');
    if (!Buffer.from(fonte, 'utf8').equals(bytes)) throw new ErroFidelidade(`${caminho}@${rev} não é UTF-8 íntegro`);
    if (idDeBlob(fonte) !== m[1]) throw new ErroFidelidade(`${caminho}@${rev}: o conteúdo não bate com o blob ${m[1]}`);
    blob = m[1];
  }
  if (lerNaRev(rev, caminho) !== fonte) {
    throw new ErroFidelidade(`o \`lerNaRev\` do gate devolve outra coisa para ${caminho}@${rev}`);
  }
  return { blob, fonte };
}

/** O estado como o núcleo o enxerga: edges, marcadores, caminhos, presença e a decisão "mudou?". */
function projetarEstado(estados: EstadoEdge[]) {
  return estados.map((e) => ({
    edge: e.edge,
    versaoBase: e.versaoBase,
    versaoHead: e.versaoHead,
    corpo: e.corpo.map((a) => ({
      caminho: a.caminho,
      base: a.base === null ? 'ausente' : 'presente',
      head: a.head === null ? 'ausente' : 'presente',
      mudou: comparavel(a.caminho, e.edge, a.base) !== comparavel(a.caminho, e.edge, a.head),
    })),
  }));
}

function exigirIgual(onde: string, doGit: unknown, doCongelado: unknown): void {
  const a = JSON.stringify(doGit);
  const b = JSON.stringify(doCongelado);
  if (a !== b) {
    throw new ErroFidelidade(`${onde} diverge:\n  git:       ${a.slice(0, 800)}\n  congelado: ${b.slice(0, 800)}`);
  }
}

function congelarFatia(
  curto: string,
  blobs: Map<string, string>,
  normalizadoDoToken: Map<string, string>,
): OndaCongelada {
  const head = gitTexto(['rev-parse', '--verify', '--quiet', `${curto}^{commit}`]).trim();
  if (!RE_SHA.test(head) || !head.startsWith(curto)) {
    throw new ErroFidelidade(`${curto} resolveu para ${JSON.stringify(head)}`);
  }
  const pais = gitTexto(['rev-list', '--parents', '-n', '1', head]).trim().split(' ');
  if (pais.length !== 2 || pais[0] !== head) {
    throw new ErroFidelidade(`${curto} tem ${pais.length - 1} pai(s); a fatia congelada é um squash, de pai ÚNICO`);
  }
  const base = pais[1];
  // o MESMO diff do `coletarEstado`, inteiro — inclusive o que o `montarEstado` descarta
  const tocados = gitTexto(['diff', '--name-only', base, head, '--', RAIZ_EDGES])
    .split('\n')
    .filter((l) => l !== '');

  const lidas = new Map<string, { leitura: LeituraCongelada; fonte: string | null }>();
  const gravador: LeitorFonte = (rev, caminho) => {
    const lado = rev === base ? 'base' : rev === head ? 'head' : null;
    if (rev === null || lado === null) {
      throw new ErroFidelidade(`o gate leu a revisão ${JSON.stringify(rev)} na fatia ${curto}`);
    }
    const chave = `${lado}\0${caminho}`;
    const ja = lidas.get(chave);
    if (ja !== undefined) return ja.fonte;
    const { blob, fonte } = lerObjeto(rev, caminho);
    const leitura: LeituraCongelada = { rev: lado, caminho, blob };
    if (blob !== null && fonte !== null) {
      if (leituraIntegral(caminho)) {
        blobs.set(blob, fonte);
      } else {
        const token = tokenDeCorpo(fonte);
        const normalizado = normalizarFonte(fonte);
        const anterior = normalizadoDoToken.get(token);
        if (anterior !== undefined && anterior !== normalizado) {
          throw new ErroFidelidade(`COLISÃO: ${token} para duas fontes normalizadas distintas (${caminho}@${lado})`);
        }
        if (normalizarFonte(token) !== token) throw new ErroFidelidade(`o gate renormaliza o token ${token}`);
        normalizadoDoToken.set(token, normalizado);
        leitura.corpo = token;
      }
    }
    lidas.set(chave, { leitura, fonte });
    return fonte;
  };
  const gravado = montarEstado(tocados, base, head, gravador);

  const leituras = [...lidas.values()]
    .map(({ leitura }) => leitura)
    .sort((a, b) => (a.caminho === b.caminho ? (a.rev < b.rev ? -1 : 1) : a.caminho < b.caminho ? -1 : 1));
  const onda: OndaCongelada = { head, base, tocados, leituras };

  // O gate de verdade (diff e `lerNaRev` dele) contra o gravado e contra o congelado: mesmas edges,
  // marcadores, caminhos, presença e decisão "mudou?" — e, por consequência, os mesmos achados.
  const real = coletarEstado(base, head);
  const congelado = montarEstado(tocados, base, head, leitorCongelado(onda, Object.fromEntries(blobs)));
  exigirIgual(`${curto}: estado do coletarEstado × gravado`, projetarEstado(real), projetarEstado(gravado));
  exigirIgual(`${curto}: estado do coletarEstado × congelado`, projetarEstado(real), projetarEstado(congelado));
  exigirIgual(`${curto}: achados do coletarEstado × congelado`, auditarBump(real), auditarBump(congelado));
  return onda;
}

/** Congela as fatias contra o git DESTE clone — toda conferência de fidelidade mora aqui. */
export function gerarArquivoOndas(): ArquivoOndas {
  if (gitTexto(['rev-parse', '--is-shallow-repository']).trim() !== 'false') {
    throw new ErroSemVerificar('clone RASO — o congelado só se gera e se confere com o histórico (`git fetch --unshallow`)');
  }
  const blobs = new Map<string, string>();
  const normalizadoDoToken = new Map<string, string>();
  const ondas = FATIAS_CONGELADAS.map((curto) => congelarFatia(curto, blobs, normalizadoDoToken));
  const ordenados = [...blobs].sort(([a], [b]) => (a < b ? -1 : 1));
  // o que sai daqui passa pela MESMA validação que a suíte aplica ao carregar
  return validarArquivoOndas(
    JSON.parse(serializarArquivoOndas({ formato: FORMATO, ondas, blobs: Object.fromEntries(ordenados) })),
  );
}

function resumo(arquivo: ArquivoOndas, bytes: number): string {
  const leituras = arquivo.ondas.flatMap((o) => o.leituras);
  const ausentes = leituras.filter((l) => l.blob === null).length;
  const deCorpo = leituras.filter((l) => l.corpo !== undefined).length;
  const tocados = arquivo.ondas.reduce((n, o) => n + o.tocados.length, 0);
  return (
    `${arquivo.ondas.length} fatias · ${tocados} tocados · ${leituras.length} leituras ` +
    `(${leituras.length - deCorpo - ausentes} integrais, ${deCorpo} de corpo, ${ausentes} ausentes) · ` +
    `${Object.keys(arquivo.blobs).length} blobs · ${bytes} bytes`
  );
}

function divergencias(commitado: string | null, gerado: ArquivoOndas): string[] {
  if (commitado === null) return ['o arquivo não existe'];
  let antigo: ArquivoOndas;
  try {
    antigo = validarArquivoOndas(JSON.parse(commitado));
  } catch (e) {
    return [`o arquivo commitado não passa na validação: ${mensagemDeErro(e) ?? 'erro sem mensagem'}`];
  }
  const d: string[] = [];
  for (let i = 0; i < Math.max(antigo.ondas.length, gerado.ondas.length); i++) {
    const a = antigo.ondas.at(i);
    const g = gerado.ondas.at(i);
    if (a === undefined || g === undefined) {
      d.push(`ondas[${i}] existe só de um lado`);
      continue;
    }
    for (const campo of ['head', 'base', 'tocados', 'leituras'] as const) {
      if (JSON.stringify(a[campo]) !== JSON.stringify(g[campo])) d.push(`ondas[${i}] (${g.head.slice(0, 9)}).${campo}`);
    }
  }
  for (const id of new Set([...Object.keys(antigo.blobs), ...Object.keys(gerado.blobs)])) {
    if (antigo.blobs[id] !== gerado.blobs[id]) d.push(`blobs[${id}]`);
  }
  if (d.length === 0) d.push('só a serialização difere (ordem ou espaço)');
  return d;
}

export function main(argv: string[]): number {
  const [modo, ...resto] = argv;
  if (resto.length > 0 || (modo !== '--gerar' && modo !== '--check')) {
    console.error(
      'uso: bun run sonda:bump-ondas -- --check   (confere o congelado contra o git, sem escrever)\n' +
        '     bun run sonda:bump-ondas -- --gerar   (reescreve o congelado; clone completo)',
    );
    return 2;
  }
  let gerado: ArquivoOndas;
  try {
    gerado = gerarArquivoOndas();
  } catch (e) {
    if (e instanceof ErroFidelidade) {
      console.error(`sonda-bump-ondas: ✗ o git contradiz o congelado — ${e.message}`);
      return 1;
    }
    console.error(`sonda-bump-ondas: ✗ NÃO CONSEGUI VERIFICAR — ${mensagemDeErro(e) ?? 'erro sem mensagem'}`);
    return 3;
  }
  const serializado = serializarArquivoOndas(gerado);
  const bytes = Buffer.byteLength(serializado, 'utf8');
  if (modo === '--gerar') {
    writeFileSync(ARQ_ONDAS_ABS, serializado);
    console.log(`sonda-bump-ondas: ✓ ${ARQ_ONDAS} regenerado — ${resumo(gerado, bytes)}`);
    return 0;
  }
  const commitado = existsSync(ARQ_ONDAS_ABS) ? readFileSync(ARQ_ONDAS_ABS, 'utf8') : null;
  if (commitado !== serializado) {
    console.error(`sonda-bump-ondas: ✗ ${ARQ_ONDAS} DIVERGE do que o git produz hoje:`);
    for (const d of divergencias(commitado, gerado)) console.error(`  - ${d}`);
    console.error('  Regenere com `bun run sonda:bump-ondas -- --gerar` e revise o diff: a mudança tem de ter causa.');
    return 1;
  }
  console.log(`sonda-bump-ondas: ✓ ${ARQ_ONDAS} confere com o git — ${resumo(gerado, bytes)}`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
