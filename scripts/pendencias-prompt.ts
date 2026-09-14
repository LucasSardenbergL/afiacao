#!/usr/bin/env bun
/**
 * pendencias-prompt.ts — emite a COLAGEM de deploy para a leva pendente.
 *
 * O `pendencias:deploy` decide QUAIS edges precisam de deploy; a forma do prompt está medida em
 * prod (2026-09-06). Este script é o meio que faltava: monta a fatia de arquivos de cada edge e
 * emite UMA colagem para a leva inteira. Ele NÃO decide se a edge precisa de deploy — quem decide
 * é o ledger, e "o mapa mudou" não é motivo (Passo 2 da `lovable-deploy-verify`).
 *
 * A lógica pura vive em `lib/prompt-deploy.ts`. Aqui fica só a borda: argv, stdin, git e os exits.
 *
 * ‼️ TUDO QUE ALIMENTA O PROMPT SAI DE `origin/main` — NUNCA DO WORKING TREE.
 * ============================================================================================
 * O Lovable deploya a MAIN, não este checkout (#2123). E `git fetch` sozinho NÃO fecha o eixo:
 * ele move `origin/main`, enquanto `existsSync`/`readFileSync` continuam lendo os bytes do disco.
 * Medido em 2026-09-04 na `enviar-pedido-portal-sayerlack`: contra o working tree o closure deu
 * **5** arquivos; contra a ref, **7**. Os dois que sumiram eram `qtde-portal.ts` (arquivo novo) e
 * `escrita-critica.ts` (import novo em arquivo pré-existente) — sem nenhum dos dois a função não
 * boota, e um closure curto se PARECE com um closure: mesma forma, menos arquivos, nada na saída
 * denuncia. `ausente ≠ zero` na dimensão ÁRVORE
 * (`.claude/skills/lovable-deploy-verify/SKILL.md` §Passo 3).
 *
 * Por isso a árvore lida é `arvoreDaRef(REF_MAIN)` e não o disco, e por isso o `git fetch` é DO
 * SCRIPT: comparar contra a `origin/main` que está em disco é o mesmo defeito um nível acima — o
 * remote-tracking ref também é um retrato. "Sincronize antes de MEDIR" só vale se a sincronização
 * for parte da MEDIÇÃO (mesmo argumento, medido, do `sonda-versao-sql.ts`: o fetch custa ~0,9 s).
 *
 * Uso:
 *   bun run pendencias:prompt <edge> [edge...]              # leva explícita
 *   bun run pendencias:deploy --json | bun run pendencias:prompt -
 *   bun run pendencias:prompt <edge> --sem-rede             # pula só o fetch (ver abaixo)
 *
 * EXIT CODES:
 *   0  prompt emitido (stdout = a colagem; o resto vai para stderr)
 *   1  nada pendente de deploy — não há colagem a emitir
 *   2  MECÂNICA não confiável: JSON ilegível ou de outro formato, `git fetch`/`origin/main` que não
 *      respondem, edge inexistente na ref, import local que não resolve (a `fecharGrafo` é
 *      fail-closed), arquivo da fatia ausente da ref, ou a auto-conferência de cobertura vermelha.
 *      Nunca imprime prompt no exit 2 — colagem incompleta é o modo de falha que este script existe
 *      para evitar (deploy parcial: boota e serve `FONTE_SHA256` velho).
 *   3  ORDEM declarada entre edges da leva (`deploy-ordem.json`, #2469). Este emissor não prova a
 *      predecessora nem parte a leva em ondas, então RECUSA com stdout vazio — o caminho com ordem é
 *      o `pendencias:pacote`. Uma colagem única aqui seria exatamente o pacote `2a52229c0e39`.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { caminhoDoManifesto, lerManifesto, type Manifesto } from './lib/ordem-entre-edges';
import {
  conferirCobertura,
  type EdgeParaDeploy,
  FORMATO_ACEITO,
  montarPrompt,
  type Procedencia,
  selecionarParaDeploy,
} from './lib/prompt-deploy';
import { ARQ_MAPA, type ArvoreDeFonte, fecharGrafo, RAIZ_EDGES, sha256Arquivo } from './sonda-fingerprint';

/** O que o Lovable deploya. Mesmo ref que o `pendencias-deploy.ts` usa para decidir a leva. */
const REMOTO = 'origin';
const RAMO_DEPLOYADO = 'main';
export const REF_DEPLOYADA = `${REMOTO}/${RAMO_DEPLOYADO}`;

// ─── git que devolve BYTES ────────────────────────────────────────────────────────────────────
//
// Os leitores de git que já existem no repo (`lerNaRev` do `sonda-versao-bump-gate`, `gitReal` do
// `sonda-versao-sql`) devolvem STRING utf8, e para o que eles fazem — comparar fonte, casar regex —
// isso está certo. Aqui não serve: o número que o prompt embute tem de ser o mesmo que
// `sha256sum <arquivo>` imprime, e `sha256sum` hasheia os bytes CRUS. Decodificar para utf8 e
// re-codificar só volta igual se a entrada for utf8 VÁLIDO; byte inválido vira U+FFFD e o hash sai
// de um conteúdo que não existe — divergência FABRICADA, que aborta um deploy correto.

/** Saída crua de um `git`. `ok:false` cobre erro, status ≠ 0 e morte por sinal (status null). */
export interface SaidaGitBytes {
  ok: boolean;
  bytes: Buffer;
  erro: string;
}

export type ExecutorGitBytes = (args: string[], entrada?: string) => SaidaGitBytes;

/**
 * `git` de verdade, sem `encoding` (⇒ Buffer).
 *
 * `r.status` nulo (morto por sinal, timeout, binário ausente) NÃO é 0: um spawn que não respondeu é
 * ausência de dado, e ausência de dado tem de cair no ramo fail-closed junto com o erro explícito.
 */
export function gitBytes(raiz: string): ExecutorGitBytes {
  return (args, entrada) => {
    // `entrada` existe para o `cat-file --batch`, que lê a lista de objetos por stdin — é como o
    // gate lê as 721 migrations da ref em UM spawn (0,05s) em vez de 721 `git show` (~27s).
    const r = spawnSync('git', args, {
      cwd: raiz,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
      ...(entrada === undefined ? {} : { input: entrada }),
    });
    if (r.error) return { ok: false, bytes: Buffer.alloc(0), erro: r.error.message };
    return {
      ok: r.status === 0,
      bytes: r.stdout ?? Buffer.alloc(0),
      erro: (r.stderr ?? Buffer.alloc(0)).toString('utf8'),
    };
  };
}

/**
 * A árvore de uma REV do git — o que `fecharGrafo` e o hash têm de ler.
 *
 * Nenhum `existsSync`, nenhum `readFileSync`: se o arquivo não está na rev, `git show` sai ≠ 0 e
 * isto devolve `null`, que é o `ausente` que a `fecharGrafo` transforma em erro. O disco desta
 * worktree não participa da decisão em nenhum ponto.
 */
export function arvoreDaRef(rev: string, git: ExecutorGitBytes): ArvoreDeFonte {
  return {
    rotulo: rev,
    ler(rel) {
      const r = git(['show', `${rev}:${rel}`]);
      return r.ok ? r.bytes : null;
    },
  };
}

/**
 * Busca a `origin/main` e devolve o SHA dela, ou LANÇA.
 *
 * `--sem-rede` pula SÓ o fetch — a leitura continua saindo da ref, nunca do disco. Ela existe
 * porque preparar a colagem offline é uso real (o deploy em si é manual, depois), e é explícita
 * justamente para não ser o padrão: o que ela admite é que a ref pode ser um retrato velho.
 */
export function sincronizarRef(git: ExecutorGitBytes, semRede: boolean): string {
  if (!semRede) {
    const f = git(['fetch', '--quiet', REMOTO, RAMO_DEPLOYADO]);
    if (!f.ok) {
      throw new Error(
        `\`git fetch ${REMOTO} ${RAMO_DEPLOYADO}\` falhou: ${primeiraLinha(f.erro)}. O prompt ` +
          `embute o sha256 de cada arquivo COMO ELE ESTÁ na ${REF_DEPLOYADA}, e uma ref velha ` +
          `manda o agente conferir contra um estado que já não é o que vai ao ar. Sem rede, ` +
          `repita com \`--sem-rede\` — a leitura continua saindo da ref que está em disco. ` +
          `Nenhum prompt foi emitido.`,
      );
    }
  }
  const r = git(['rev-parse', '--verify', '--quiet', `${REF_DEPLOYADA}^{commit}`]);
  const sha = r.bytes.toString('utf8').trim();
  if (!r.ok || sha === '') {
    throw new Error(
      `${REF_DEPLOYADA} não existe neste repo${semRede ? ' e --sem-rede proíbe buscá-la' : ''} — ` +
        `não há de onde tirar os bytes que o Lovable vai deployar, e ausência de dado não é ` +
        `aprovação. Rode \`git fetch ${REMOTO}\` num repo com o remote configurado. ` +
        `Nenhum prompt foi emitido.`,
    );
  }
  return sha;
}

function primeiraLinha(s: string): string {
  return (s.split('\n').find((l) => l.trim() !== '') ?? '(sem stderr)').trim();
}

/**
 * A fatia que o deploy tem de nomear: fecho transitivo ∪ {mapa}, cada arquivo com o sha256 dos
 * bytes que a ÁRVORE tem.
 *
 * O mapa entra SEMPRE, mesmo em edge não instrumentada: nomear um `_shared` a mais é inócuo (ele
 * já está no bundle), enquanto omiti-lo produz deploy que boota e serve fingerprint velho. A
 * assimetria manda no default — fail-closed no lado que dói.
 *
 * O hash é por ARQUIVO (`sha256Arquivo`), não o da fatia (`digerir`): quem vai recalcular é um
 * agente rodando `sha256sum` no sandbox, e nenhum comando de shell reproduz o encadeamento
 * `caminho \0 tamanho \0 bytes` do fingerprint. Hash que o outro lado não consegue refazer é
 * decoração.
 */
export function fatiaDeDeploy(edge: string, raiz: string, arvore: ArvoreDeFonte): EdgeParaDeploy {
  const entrada = `${RAIZ_EDGES}/${edge}/index.ts`;
  if (arvore.ler(entrada) === null) {
    throw new Error(`edge inexistente em ${arvore.rotulo}: ${entrada}`);
  }
  const caminhos = [...new Set([...fecharGrafo(entrada, raiz, arvore), ARQ_MAPA])].sort();
  const arquivos = caminhos.map((caminho) => {
    const bytes = arvore.ler(caminho);
    if (bytes === null) {
      throw new Error(
        `arquivo da fatia não existe em ${arvore.rotulo}: ${caminho} — a colagem nomearia um ` +
          `arquivo que o deploy não tem como ler, e o hash sairia de lugar nenhum`,
      );
    }
    return { caminho, sha256: sha256Arquivo(bytes) };
  });
  return { edge, arquivos };
}

/**
 * Os caminhos da ÁRVORE do commit `sha` sob os diretórios das `edges` — um `ls-tree` que TEM de
 * responder.
 *
 * Existe porque `arvoreDaRef().ler()` devolve `null` tanto para "o arquivo não está no commit" quanto
 * para "o git falhou". Para o `index.ts` isso basta — ausente aborta. Para um arquivo OPCIONAL, como
 * o manifesto de ordem, o `null` se leria "sem ordem" e liberaria a edge dependente (P1 do Codex,
 * 2026-09-14): a ausência precisa ser PROVADA por um inventário que respondeu.
 */
export function inventarioDaRef(git: ExecutorGitBytes, sha: string, edges: readonly string[]): Set<string> {
  const dirs = [...new Set(edges)].sort().map((e) => `${RAIZ_EDGES}/${e}/`);
  const r = git(['ls-tree', '-r', '--name-only', sha, '--', ...dirs]);
  if (!r.ok) {
    throw new Error(
      `\`git ls-tree\` em ${sha.slice(0, 9)} falhou: ${primeiraLinha(r.erro)} — sem inventário não sei se ` +
        'há manifesto de ordem, e "não sei" não é "não há"',
    );
  }
  return new Set(r.bytes.toString('utf8').split('\n').filter((l) => l !== ''));
}

/**
 * Os manifestos de ordem (`deploy-ordem.json`, #2469) das edges da leva, lidos do COMMIT `sha`.
 *
 * Controle positivo: o `index.ts` de cada edge pedida TEM de aparecer no inventário — listagem vazia
 * ou truncada não passa por "nenhum manifesto". Manifesto listado e ilegível LANÇA, e manifesto fora
 * do contrato também (`lerManifesto`); quem chama converte em exit 2.
 */
export function lerManifestosDaRef(
  git: ExecutorGitBytes,
  sha: string,
  edges: readonly string[],
): Map<string, Manifesto> {
  const inventario = inventarioDaRef(git, sha, edges);
  const cegas = edges.filter((e) => !inventario.has(`${RAIZ_EDGES}/${e}/index.ts`));
  if (cegas.length > 0) {
    throw new Error(
      `o inventário de ${sha.slice(0, 9)} não lista o index.ts de ${cegas.join(', ')} — listagem que não vê ` +
        'a própria edge não prova ausência de manifesto',
    );
  }
  const manifestos = new Map<string, Manifesto>();
  for (const edge of edges) {
    const caminho = caminhoDoManifesto(edge);
    if (!inventario.has(caminho)) continue;
    const r = git(['show', `${sha}:${caminho}`]);
    if (!r.ok) {
      throw new Error(`${caminho} está no commit ${sha.slice(0, 9)} e não foi lido: ${primeiraLinha(r.erro)}`);
    }
    manifestos.set(edge, lerManifesto(edge, r.bytes.toString('utf8')));
  }
  return manifestos;
}

/** Lê o `--json` do `pendencias:deploy` e devolve as edges que exigem deploy. */
export function lerVeredito(bruto: string): string[] {
  let obj: unknown;
  try {
    obj = JSON.parse(bruto);
  } catch (e) {
    throw new Error(`stdin não é JSON: ${(e as Error).message}`);
  }
  const rel = obj as { formato?: unknown; vereditos?: unknown };
  if (rel.formato !== FORMATO_ACEITO) {
    throw new Error(
      `formato inesperado: ${String(rel.formato)} (esperado ${FORMATO_ACEITO}) — ` +
        `o contrato do pendencias:deploy mudou, NÃO adivinhe a leva`,
    );
  }
  if (!Array.isArray(rel.vereditos)) {
    throw new Error('JSON sem `vereditos` — ausente ≠ leva vazia');
  }
  return selecionarParaDeploy(rel.vereditos);
}

export function main(argv: string[], raiz = process.cwd(), git = gitBytes(raiz)): number {
  const args = argv.filter((a) => a !== '');
  const semRede = args.includes('--sem-rede');
  const nomesArgs = args.filter((a) => a !== '--sem-rede');
  if (nomesArgs.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      'uso: bun run pendencias:prompt <edge> [edge...] [--sem-rede]\n' +
        '     bun run pendencias:deploy --json | bun run pendencias:prompt -\n',
    );
    return 2;
  }

  let nomes: string[];
  try {
    nomes = nomesArgs.length === 1 && nomesArgs[0] === '-'
      ? lerVeredito(readFileSync(0, 'utf8'))
      : nomesArgs;
  } catch (e) {
    process.stderr.write(`⛔ mecânica: ${(e as Error).message}\n`);
    return 2;
  }

  if (nomes.length === 0) {
    process.stderr.write('✓ nada pendente de deploy — nenhuma colagem a emitir\n');
    return 1;
  }

  let proc: Procedencia;
  let leva: EdgeParaDeploy[];
  let comOrdem: string[];
  try {
    proc = { ref: REF_DEPLOYADA, sha: sincronizarRef(git, semRede) };
    // A árvore sai do SHA resolvido, não do NOME da ref (o contrato do pacote, #2428): o manifesto de
    // ordem logo abaixo tem de falar do MESMO commit que a fatia.
    const arvore = arvoreDaRef(proc.sha, git);
    leva = nomes.map((n) => fatiaDeDeploy(n, raiz, arvore));
    comOrdem = [...lerManifestosDaRef(git, proc.sha, nomes).keys()].sort();
  } catch (e) {
    process.stderr.write(`⛔ mecânica: ${(e as Error).message}\n`);
    return 2;
  }

  if (comOrdem.length > 0) {
    process.stderr.write(
      `⛔ ordem declarada entre edges (deploy-ordem.json) em: ${comOrdem.join(', ')}.\n` +
        '   Este emissor não prova a predecessora nem parte a leva em ondas — use o pacote:\n' +
        '   PEND=$(mktemp -t pend); bun scripts/pendencias-deploy.ts --json > "$PEND"; ' +
        'bun scripts/pendencias-pacote.ts - < "$PEND"\n' +
        '   Nenhum prompt foi emitido.\n',
    );
    return 3;
  }

  const prompt = montarPrompt(leva, proc);

  // Auto-conferência: o próprio check que o histórico prescreve, aplicado à saída antes de
  // imprimi-la. Vermelho aqui é bug do gerador, não do repo — e imprimir mesmo assim entregaria
  // a colagem incompleta que este script existe para impedir.
  const cobertura = conferirCobertura(prompt, leva);
  if (!cobertura.ok) {
    process.stderr.write(
      `⛔ mecânica: o prompt gerado não cobre a fatia — faltando: ${cobertura.faltando.join(', ')}\n`,
    );
    return 2;
  }

  const totalArquivos = leva.reduce((s, e) => s + e.arquivos.length, 0);
  process.stderr.write(
    `✓ leva de ${leva.length} edge(s) · ${totalArquivos} arquivos · sha256 de ` +
      `${proc.ref}@${proc.sha.slice(0, 9)}${semRede ? ' (--sem-rede: ref NÃO buscada)' : ''} · ` +
      `cobertura conferida\n` +
      `  Cole no chat do Lovable APÓS o merge na main. Depois: bun run sonda:sql ${nomes.join(' ')}\n\n`,
  );
  process.stdout.write(`${prompt}\n`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
