#!/usr/bin/env bun
/**
 * sonda-fingerprint.ts — a identidade SERVIDA passa a ser função do CONTEÚDO.
 * ============================================================================================
 *
 * ## O buraco que ele tapa (e que NÃO é o do `sonda:bump`)
 *
 * O gate `sonda:bump` (`scripts/sonda-versao-bump-gate.ts`, #1993) exige bump do `VERSAO` quando a
 * fatia altera o corpo servido de uma edge. Ele resolve a OMISSÃO — e deixa `_shared/` de fora de
 * propósito, com medição no cabeçalho dele: cobri-lo daria 290 pares edge×fatia em 25 fatias,
 * ~12 bumps À MÃO por PR. Inviável, e a conclusão está certa.
 *
 * Só que o buraco continua aberto: uma mudança de comportamento pode chegar INTEIRA por `_shared/`
 * sem tocar `index.ts` nem `versao.ts`. Medido: o `8ee8afa15` trouxe metade da reescrita do
 * pós-login Sayerlack via `_shared/sayerlack-pos-login.ts`. Nesse caso o `VERSAO` não muda, a sonda
 * responde a mesma string nos dois bundles, e a discriminação some — a mesma classe do #1971.
 *
 * ## Por que fingerprint resolve o que bump à mão não resolve
 *
 * O fan-out de `_shared/` só é insuportável se um HUMANO bumpar 12 marcadores. Se o CI REGENERA, o
 * fan-out é de graça — e é CORRETO: os 12 bundles mudaram mesmo. É a diferença entre pedir
 * disciplina e derivar a identidade do conteúdo.
 *
 * ⚠️ **Isto só vale porque o fingerprint é SERVIDO.** Um fingerprint que só existe no repo é
 * escrituração: com `VERSAO=X` em prod e o repo dizendo X↔F1 enquanto o HEAD está em F2, não dá
 * para saber se prod tem F1 (deploy antes da mudança de `_shared/`) ou F2 (deploy depois, sem bump).
 * Os dois estados respondem idêntico. Quem discrimina é a RESPOSTA mudar — por isso o mapa entra em
 * `criarRespostaSonda`, e a sonda passa a devolver `fonte`.
 *
 * ## A régua
 *
 * Para cada edge instrumentada (a que tem `versao.ts`), o fingerprint é SHA-256 sobre o FECHO
 * TRANSITIVO dos imports LOCAIS a partir do `index.ts` — incluindo `_shared/`. Ficam fora:
 *
 *   · import REMOTO (`https:`, `npm:`, `jsr:`, `node:`) — não é fonte nossa, e não há `deno.lock`
 *     versionado que o fixe (ver a ⚠️ de honestidade no fim deste bloco);
 *   · `*_test.ts` / `*.test.ts` — não entram no bundle;
 *   · o próprio `_shared/sonda-fingerprints.ts` — ele é a SAÍDA. Incluí-lo seria ponto-fixo:
 *     gravar o hash mudaria o hash. É o ÚNICO arquivo excluído por ser saída, e a exclusão é
 *     cirúrgica de propósito — o `versao.ts` entra INTEIRO (ele carrega `EFEITO` e a fábrica de
 *     resposta, que são comportamento, não só o marcador).
 *
 * Determinismo: ordena por caminho relativo ao repo e alimenta `caminho \0 tamanho \0 bytes` no
 * digest. O caminho e o tamanho entram junto com os bytes para que renomear e concatenar não
 * colidam — hash só do conteúdo concatenado é ambíguo entre {"ab","c"} e {"a","bc"}.
 *
 * ⚠️ **É fingerprint da FONTE, não hash do BUNDLE — e o nome importa.** Não há `deno.lock`
 * versionado e há range aberto (`npm:@supabase/supabase-js@2`), então a MESMA fonte pode resolver
 * dependência externa diferente entre dois deploys. Isto identifica o que está NO REPO, não o
 * artefato servido. Chamar de "hash do bundle" prometeria o que ele não entrega.
 *
 * ⚠️ **Não prova atomicidade do deploy.** Se o deploy misturar `_shared/` novo com `index.ts`
 * velho, o mapa (que é fonte também) mente junto. Só hash calculado em RUNTIME fecharia isso, e a
 * edge não lê a própria fonte em Deno Deploy. Limite conhecido, não promessa.
 *
 * ## Modos
 *
 *   bun scripts/sonda-fingerprint.ts            # GATE: recalcula e compara com o mapa commitado
 *   bun scripts/sonda-fingerprint.ts --write     # regrava o mapa (é o que o CI/dev roda ao mudar)
 *
 * Fail-CLOSED: edge instrumentada ausente do mapa, `index.ts` ilegível ou import local que não
 * resolve REPROVAM. Gate que degrada para "não consegui medir" não guarda nada — a lição do
 * `docs/historico/sonda-ausente-em-script-que-apaga.md`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export const RAIZ_EDGES = 'supabase/functions';
export const ARQ_MARCADOR = 'versao.ts';
/** A SAÍDA — único arquivo excluído do fecho por ser o que este script grava (ponto-fixo). */
export const ARQ_MAPA = `${RAIZ_EDGES}/_shared/sonda-fingerprints.ts`;

/** Import remoto: não é fonte nossa. `node:` entra aqui porque é builtin, não arquivo do repo. */
const PREFIXO_REMOTO = ['https:', 'http:', 'npm:', 'jsr:', 'node:', 'data:'];

export function ehRemoto(especificador: string): boolean {
  return PREFIXO_REMOTO.some((p) => especificador.startsWith(p));
}

export function ehTeste(caminho: string): boolean {
  return /(^|\/)[^/]*(_test|\.test)\.[cm]?[jt]sx?$/.test(caminho);
}

/**
 * Extrai especificadores de import/export/`import(...)` de um fonte TS.
 *
 * Regex e não parser de propósito: o alvo é `supabase/functions/`, que é Deno com extensão
 * OBRIGATÓRIA no import — então o especificador é sempre um literal com `.ts` no fim, sem
 * resolução de índice nem de `paths`. Um parser aqui compraria complexidade para um grau de
 * liberdade que este diretório não tem.
 *
 * ⚠️ Roda sobre o fonte COM comentários de propósito: um import comentado não está no bundle, mas
 * incluí-lo no fecho só ADICIONA arquivo ao hash (erra para o lado de sobre-reportar). Descomentar
 * para "limpar" arriscaria o inverso — perder um import real por um stripper que não entende
 * template string — e aí o gate ficaria VERDE POR CEGUEIRA, que é a falha que não se vê.
 */
export function extrairImportsLocais(fonte: string): string[] {
  const achados: string[] = [];
  const padroes = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of padroes) {
    for (const m of fonte.matchAll(re)) {
      const esp = m[1];
      if (!ehRemoto(esp) && (esp.startsWith('./') || esp.startsWith('../'))) achados.push(esp);
    }
  }
  return [...new Set(achados)];
}

/** Fecho transitivo dos imports locais a partir de `entrada`. Caminhos relativos ao repo, ordenados. */
export function fecharGrafo(entrada: string, raiz = process.cwd()): string[] {
  const vistos = new Set<string>();
  const fila = [resolve(raiz, entrada)];
  while (fila.length > 0) {
    const abs = fila.pop() as string;
    const rel = relative(raiz, abs);
    if (vistos.has(rel)) continue;
    if (!existsSync(abs)) {
      throw new Error(
        `import local que NÃO resolve: ${rel} (a partir de ${entrada}). Fail-closed: um fecho ` +
          `incompleto produziria fingerprint que ignora arquivo servido.`,
      );
    }
    if (ehTeste(rel) || rel === ARQ_MAPA) continue;
    vistos.add(rel);
    for (const esp of extrairImportsLocais(readFileSync(abs, 'utf8'))) {
      fila.push(resolve(dirname(abs), esp));
    }
  }
  return [...vistos].sort();
}

/** SHA-256 sobre `caminho \0 tamanho \0 bytes` de cada arquivo, em ordem estável. */
export function digerir(arquivos: string[], raiz = process.cwd()): string {
  const h = createHash('sha256');
  for (const rel of arquivos) {
    const bytes = readFileSync(resolve(raiz, rel));
    h.update(rel);
    h.update('\0');
    h.update(String(bytes.length));
    h.update('\0');
    h.update(bytes);
  }
  return h.digest('hex');
}

/** As edges instrumentadas — as que têm `versao.ts`. */
export function edgesInstrumentadas(raiz = process.cwd()): string[] {
  const base = resolve(raiz, RAIZ_EDGES);
  return readdirSync(base)
    .filter((n) => n !== '_shared' && statSync(join(base, n)).isDirectory())
    .filter((n) => existsSync(join(base, n, ARQ_MARCADOR)))
    .sort();
}

export function calcularTodos(raiz = process.cwd()): Record<string, string> {
  const mapa: Record<string, string> = {};
  for (const edge of edgesInstrumentadas(raiz)) {
    mapa[edge] = digerir(fecharGrafo(`${RAIZ_EDGES}/${edge}/index.ts`, raiz), raiz);
  }
  return mapa;
}

const CABECALHO = `// GERADO por \`bun scripts/sonda-fingerprint.ts --write\` — NÃO editar à mão.
//
// Fingerprint da FONTE de cada edge instrumentada: SHA-256 sobre o fecho transitivo dos imports
// LOCAIS a partir do \`index.ts\`, incluindo \`_shared/\`. É a metade que o gate \`sonda:bump\` não
// alcança: ele cobre mudança dentro da pasta da edge, e \`_shared/\` ficou fora dele de propósito
// (~12 bumps à mão por PR). Aqui o fan-out é de graça porque o CI REGENERA.
//
// Servido por \`criarRespostaSonda\` no campo \`fonte\` — é isso que torna a identidade função do
// CONTEÚDO, e não da disciplina de quem bumpa. Regravar este arquivo à mão para calar o gate
// derrota o mecanismo inteiro: rode o \`--write\`.
//
// ⚠️ Fingerprint da FONTE, não hash do BUNDLE — não há \`deno.lock\` versionado e há range aberto
// (\`npm:@supabase/supabase-js@2\`), então a mesma fonte pode resolver dependência externa diferente.

export const FONTE_SHA256: Record<string, string> = {`;

export function renderizarMapa(mapa: Record<string, string>): string {
  const linhas = Object.keys(mapa)
    .sort()
    .map((edge) => `  ${JSON.stringify(edge)}: ${JSON.stringify(mapa[edge])},`);
  return `${CABECALHO}\n${linhas.join('\n')}\n};\n`;
}

export function lerMapaCommitado(raiz = process.cwd()): Record<string, string> {
  const abs = resolve(raiz, ARQ_MAPA);
  if (!existsSync(abs)) return {};
  const fonte = readFileSync(abs, 'utf8');
  const mapa: Record<string, string> = {};
  for (const m of fonte.matchAll(/^\s*"([^"]+)":\s*"([0-9a-f]{64})",$/gm)) mapa[m[1]] = m[2];
  return mapa;
}

export function main(argv: string[]): number {
  const escrever = argv.includes('--write');
  const raiz = process.cwd();
  const atual = calcularTodos(raiz);

  if (escrever) {
    writeFileSync(resolve(raiz, ARQ_MAPA), renderizarMapa(atual), 'utf8');
    console.log(`sonda-fingerprint: mapa regravado — ${Object.keys(atual).length} edge(s).`);
    return 0;
  }

  const commitado = lerMapaCommitado(raiz);
  const problemas: string[] = [];
  for (const edge of Object.keys(atual).sort()) {
    if (commitado[edge] === undefined) {
      problemas.push(`${edge}: instrumentada mas AUSENTE do mapa`);
    } else if (commitado[edge] !== atual[edge]) {
      problemas.push(
        `${edge}: fonte mudou e o mapa não — commitado ${commitado[edge].slice(0, 12)}…, ` +
          `atual ${atual[edge].slice(0, 12)}…`,
      );
    }
  }
  for (const edge of Object.keys(commitado).sort()) {
    if (atual[edge] === undefined) problemas.push(`${edge}: no mapa mas não é edge instrumentada`);
  }

  if (problemas.length > 0) {
    console.error('sonda-fingerprint: o mapa não corresponde à fonte.\n');
    for (const p of problemas) console.error(`  ✗ ${p}`);
    console.error(
      '\nConserto: `bun run sonda:fingerprint -- --write` e commite o mapa.\n' +
        'Se a mudança foi de COMPORTAMENTO, bumpe também o `VERSAO` da(s) edge(s) — o fingerprint\n' +
        'diz QUE a fonte mudou, o `VERSAO` diz O QUE mudou, e a sonda serve os dois.',
    );
    return 1;
  }
  console.log(`sonda-fingerprint: ✓ ${Object.keys(atual).length} edge(s) — mapa bate com a fonte.`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
