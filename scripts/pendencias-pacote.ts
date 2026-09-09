#!/usr/bin/env bun
/**
 * pendencias-pacote.ts — o PACOTE DE ENTREGA de uma leva, com a ordem entre camadas como GATE.
 *
 * ## Por que existe
 *
 * `docs/historico/ordem-entre-camadas-do-mesmo-pr.md` (#2285) mediu o buraco e nomeou os três donos
 * que não o cobrem:
 *
 *   · `pendencias:deploy`  compara bundle servido × main — **não abre `supabase/migrations/`**;
 *   · `audit:migrations`   inventaria migrations — **não sabe que uma edge foi ao ar dependendo de uma**;
 *   · o cabeçalho da migration declara a ordem — **em prosa, para um humano que talvez não a abra**.
 *
 * O resultado medido: a edge do #2285 serviu **≥2h25** chamando uma RPC que não existia. Ninguém
 * desobedeceu à ordem — ninguém foi perguntado. O doc fechou pedindo o que falta aqui:
 *
 *   > a dependência tem de existir como ARTEFATO VERIFICÁVEL, não como parágrafo.
 *
 * ## O que este script acrescenta ao que já existia
 *
 * `preflight:rpcs` já sabe QUAIS RPCs uma edge chama e já EMITE a query de cruzamento com prod.
 * Mas emitir a query é a mesma prosa executável do cabeçalho: alguém tem de rodá-la, e no #2285
 * ninguém rodou. Este script **roda** (leitura é minha, via `psql-ro`), **julga** fail-closed
 * (`lib/precondicao-banco.ts`) e **recusa emitir a colagem da edge** enquanto o banco não estiver
 * pronto — que é a única forma da ordem virar gate em vez de recomendação.
 *
 * A ordem que ele impõe é a do desenho: **DDL primeiro, edge depois, Publish por último.**
 *
 * ## O que ele deliberadamente NÃO faz
 *
 * · **Não decide se a edge precisa de deploy.** Quem decide é o ledger (`pendencias:deploy`), e
 *   "o mapa mudou" não é motivo (`deploy-redundante-ledger-e-cron-de-sonda.md`). Este script recebe
 *   a leva pronta e só responde "PODE AGORA?".
 * · **Não concatena migrations.** A medida de 2026-09-07 (74 migrations/30d, **1,16 por PR**, 115/115
 *   objetos já em prod) mostra que a fila pendente é ~1: não há lote a juntar, e juntar histórico
 *   reaplicaria DDL sobre hardening posterior — `REVOKE`/ACL aplicado depois some num replay ingênuo.
 * · **Não escreve no banco.** O founder continua aplicando pelo SQL Editor; o ganho é ordem e
 *   conferência, não automação de escrita.
 *
 * ## Exit codes
 *   0  pacote emitido — pré-condição de banco MEDIDA e satisfeita, a edge pode subir
 *   1  nada pendente na leva — não há pacote a emitir
 *   2  MECÂNICA não confiável: psql falhou, edge inexistente, JSON de outro formato
 *   3  **BLOQUEADO** — a pré-condição está ausente (`BLOQUEADA`) ou não pôde ser medida
 *      (`INCERTA`). Nos dois casos o pacote sai com o passo de DDL e **sem** a colagem da edge:
 *      emitir a colagem aqui seria reencenar o #2285 com a ferramenta que existe para evitá-lo.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { mensagemDeErro } from '@/lib/erro-mensagem';

import { historicoDeCorpos, type MigrationLida } from './lib/corpo-esperado';
import { coletarDaEdge } from './lib/edge-rpcs';
import {
  agruparAlvos,
  alvosDeCorpo,
  type CorposEsperados,
  julgarPrecondicao,
  montarSondaPrecondicao,
  parsearSondaPrecondicao,
  relatarPrecondicao,
  type VereditoPrecondicao,
} from './lib/precondicao-banco';
import { FORMATO_ACEITO, type Procedencia, selecionarParaDeploy } from './lib/prompt-deploy';
import {
  arvoreDaRef,
  type ExecutorGitBytes,
  fatiaDeDeploy,
  gitBytes,
  REF_DEPLOYADA,
  sincronizarRef,
} from './pendencias-prompt';
import { montarPacote, type PacoteFonte } from './lib/pacote-entrega';

const PSQL_RO = process.env.PSQL_RO ?? join(homedir(), '.config', 'afiacao', 'psql-ro');

/** Lê o `--json` do `pendencias:deploy`. Mesmo contrato do `pendencias:prompt` — um só dono. */
export function lerVeredito(bruto: string): string[] {
  let obj: unknown;
  try {
    obj = JSON.parse(bruto);
  } catch (e) {
    throw new Error(`stdin não é JSON: ${mensagemDeErro(e) ?? 'ilegível'}`);
  }
  const rel = obj as { formato?: unknown; vereditos?: unknown };
  if (rel.formato !== FORMATO_ACEITO) {
    throw new Error(
      `formato inesperado: ${String(rel.formato)} (esperado ${FORMATO_ACEITO}) — ` +
        'o contrato do pendencias:deploy mudou, NÃO adivinhe a leva',
    );
  }
  if (!Array.isArray(rel.vereditos)) throw new Error('JSON sem `vereditos` — ausente ≠ leva vazia');
  return selecionarParaDeploy(rel.vereditos);
}

/** Roda a sonda pelo wrapper read-only. `-c` (não `-f`) porque só `-c` sai 1 em ERROR. */
export function medirEmProd(sql: string): string {
  return execFileSync(PSQL_RO, ['-A', '-F', '|', '-t', '-c', sql], {
    encoding: 'utf8',
    timeout: 60_000,
  });
}

/**
 * Separa `--saida <arquivo>` dos alvos. Pura, e exportada porque a expressão que ela substitui
 * fabricava VEREDITO VERDE: com `--saida` ausente, `args.indexOf('--saida')` é `-1`, logo
 * `iSaida + 1` é **0**, e o `filter` descartava o argumento de índice 0 — o `-` do pipe canônico
 * impresso no próprio `uso:`, ou a única edge nomeada. A leva chegava vazia e o CLI anunciava
 * "✓ nada pendente de deploy" sobre uma leva que nunca leu. Medido em 2026-09-08:
 * `pendencias:pacote copilot-analyze` dizia "nada pendente" enquanto `pendencias:deploy` a
 * acusava `DIVERGE_P1` — o gate de ordem do #2369 nasceu cego no caminho que ele existe para
 * gatear.
 */
export function separarSaida(args: readonly string[]): { nomes: string[]; saida?: string } {
  const iSaida = args.indexOf('--saida');
  if (iSaida < 0) return { nomes: [...args] };
  return { nomes: args.filter((_, i) => i !== iSaida && i !== iSaida + 1), saida: args[iSaida + 1] };
}

/** Onde as migrations vivem na árvore. Uma constante porque o `git grep` e o `ls-tree` a repetem. */
const DIR_MIGRATIONS = 'supabase/migrations';

/**
 * TODAS as migrations da ref, lidas do commit `sha`.
 *
 * 🔴 Do commit, não do `working tree`, e não da REF pelo NOME. Ler do disco reencena o #2427 (o
 * gate media um `index.ts` que ninguém ia deployar); ler por `origin/main` reencena o mesmo defeito
 * um andar acima — a ref é MUTÁVEL, outra worktree pode movê-la no meio desta execução, e aí as
 * edges saem de um commit e as migrations de outro. O `sha` já foi resolvido uma vez pelo
 * `sincronizarRef`; é ele que manda em tudo (achado do Codex).
 *
 * 🔴 TODAS, e não as que um filtro escolher. A primeira versão filtrava candidatos com
 * `git grep -l -E "\\b(nome1|nome2)\\b"` — e `\b` **não é word-boundary em POSIX ERE**, então o
 * grep casou ZERO arquivos, saiu 1 sem escrever em stderr, e o código leu isso como "nenhum
 * candidato". O gate rodou contra prod inteiro, encontrou o histórico VAZIO e liberou a leva:
 * fail-open silencioso, a mesma classe que este PR existe para fechar, reencenada dentro dele.
 * Foi pego rodando contra prod, não pelos testes — que passavam todos.
 *
 * O conserto não foi tirar o `\b`: foi tirar o FILTRO. `git cat-file --batch` lê os 721 arquivos
 * (6,4 MB) num spawn só em **0,05s** — mais rápido que o `git grep` que o filtro economizava. Um
 * otimizador com um modo de falha silencioso não estava pagando por si.
 *
 * O controle positivo é a CONTAGEM: cada blob pedido tem de voltar. Um `--batch` que devolva menos
 * do que se pediu é árvore mudando sob os pés, e lança — nunca vira um histórico curto que se leria
 * como "esta função não tem DDL commitada".
 */
function migrationsDaRef(git: ExecutorGitBytes, sha: string): MigrationLida[] {
  const inv = git(['ls-tree', '-r', sha, '--', `${DIR_MIGRATIONS}/`]);
  if (!inv.ok) throw new Error(`git ls-tree em ${sha} falhou: ${inv.erro.trim() || 'sem stderr'}`);

  // `<mode> SP <type> SP <oid> TAB <path>` — a ordem lexical do path é a ordem de apply.
  const entradas = inv.bytes
    .toString('utf8')
    .split('\n')
    .flatMap((linha) => {
      const [meta, caminho] = linha.split('\t');
      const oid = meta?.split(' ')[2];
      if (oid === undefined || caminho === undefined || !caminho.endsWith('.sql')) return [];
      return [{ oid, nome: caminho.slice(`${DIR_MIGRATIONS}/`.length) }];
    })
    .sort((a, b) => a.nome.localeCompare(b.nome, 'en'));

  if (entradas.length === 0) {
    throw new Error(
      `nenhuma migration em ${sha}:${DIR_MIGRATIONS}/ — é o inventário quebrado, não um repo sem ` +
        'DDL; sem histórico o eixo de corpo não teria com o que comparar e liberaria a leva',
    );
  }

  const lote = git(['cat-file', '--batch'], `${entradas.map((e) => e.oid).join('\n')}\n`);
  if (!lote.ok) throw new Error(`git cat-file em ${sha} falhou: ${lote.erro.trim() || 'sem stderr'}`);

  const lidas = lerLoteDeBlobs(lote.bytes, entradas);
  if (lidas.length !== entradas.length) {
    throw new Error(
      `git cat-file devolveu ${lidas.length} de ${entradas.length} migrations — leitura PARCIAL; ` +
        'um histórico curto se leria como "esta função não tem DDL commitada"',
    );
  }
  return lidas;
}

/**
 * Desempacota a saída do `git cat-file --batch`: por objeto, `<oid> SP <type> SP <size> LF`, os
 * `size` bytes do conteúdo, e um LF. Fatiar por TAMANHO (e não procurar o próximo cabeçalho) é o
 * que torna o parser imune a um `.sql` que contenha algo parecido com um cabeçalho.
 *
 * Para no primeiro registro malformado em vez de pular: quem chama compara a contagem, e uma
 * varredura que "se recupera" devolveria uma lista curta com cara de completa.
 */
function lerLoteDeBlobs(
  saida: Buffer,
  entradas: readonly { oid: string; nome: string }[],
): MigrationLida[] {
  const fora: MigrationLida[] = [];
  let pos = 0;
  for (const entrada of entradas) {
    const fimCabecalho = saida.indexOf(0x0a, pos);
    if (fimCabecalho < 0) return fora;
    const partes = saida.toString('utf8', pos, fimCabecalho).split(' ');
    // `<oid> missing` tem 2 campos; um blob tem 3. Qualquer outra coisa é formato que não conheço.
    if (partes.length !== 3 || partes[1] !== 'blob') return fora;
    const tamanho = Number.parseInt(partes[2], 10);
    if (!Number.isFinite(tamanho) || tamanho < 0) return fora;
    const ini = fimCabecalho + 1;
    if (ini + tamanho > saida.length) return fora;
    fora.push({ nome: entrada.nome, sql: saida.toString('utf8', ini, ini + tamanho) });
    pos = ini + tamanho + 1; // +1 pelo LF que o git põe depois do conteúdo
  }
  return fora;
}

export function main(
  argv: string[],
  raiz = process.cwd(),
  git = gitBytes(raiz),
  medir = medirEmProd,
): number {
  const todos = argv.filter((a) => a !== '');
  const semRede = todos.includes('--sem-rede');
  const args = todos.filter((a) => a !== '--sem-rede');
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      'uso: bun run pendencias:pacote <edge> [edge...] [--saida <arquivo.md>] [--sem-rede]\n' +
        '     bun run pendencias:deploy --json | bun run pendencias:pacote -\n',
    );
    return 2;
  }

  const { nomes: nomesArg, saida: saidaExplicita } = separarSaida(args);
  if (args.includes('--saida') && saidaExplicita === undefined) {
    process.stderr.write('⛔ mecânica: --saida sem caminho\n');
    return 2;
  }

  let nomes: string[];
  try {
    nomes =
      nomesArg.length === 1 && nomesArg[0] === '-'
        ? lerVeredito(readFileSync(0, 'utf8'))
        : nomesArg;
  } catch (e) {
    process.stderr.write(`⛔ mecânica: ${mensagemDeErro(e) ?? 'stdin ilegível'}\n`);
    return 2;
  }

  if (nomes.length === 0) {
    // Leva vazia só é NOTÍCIA quando veio do veredito (`-`). Com alvos NOMEADOS, lista vazia é
    // mecânica quebrada — foi exatamente assim que o bug de índice se escondeu por um dia.
    if (nomesArg.length === 1 && nomesArg[0] === '-') {
      process.stderr.write('✓ nada pendente de deploy — nenhum pacote a emitir\n');
      return 1;
    }
    process.stderr.write(
      '⛔ mecânica: alvos nomeados sumiram no parsing de argumentos — leva NÃO consultada\n',
    );
    return 2;
  }

  // ── camada 1: o que a leva EXIGE do banco ──────────────────────────────────────────────────
  const pares: { edge: string; rpc: string }[] = [];
  let indirecoes = 0;
  let fatias: PacoteFonte['edges'];
  let proc: Procedencia;
  try {
    // A fatia sai da MESMA ref que o Lovable deploya, não do disco: é o contrato do #2362, e o
    // pacote herda dele o sha256 por arquivo — hash que o outro lado consegue refazer.
    proc = { ref: REF_DEPLOYADA, sha: sincronizarRef(git, semRede) };
    // A árvore sai do SHA, não do NOME da ref: `origin/main` é mutável e outra worktree pode
    // movê-la no meio desta execução — o pacote sairia com a fatia de um commit, o hash de outro e
    // as migrations de um terceiro. O `proc.sha` já foi resolvido; é ele que manda (Codex, #2428).
    const arvore = arvoreDaRef(proc.sha, git);
    fatias = nomes.map((edge) => {
      // A MESMA `arvore` das duas metades: a fatia da colagem e a descoberta das RPCs que a
      // liberam têm de falar do MESMO arquivo. Ler as RPCs do disco enquanto a colagem sai da ref
      // era o gate medindo um `index.ts` que ninguém vai deployar.
      const achado = coletarDaEdge(edge, arvore, raiz);
      for (const r of achado.rpcs) pares.push({ edge, rpc: r.nome });
      indirecoes += achado.indirecoes.length;
      return { ...fatiaDeDeploy(edge, raiz, arvore), rpcs: achado.rpcs.map((r) => r.nome).sort() };
    });
  } catch (e) {
    process.stderr.write(`⛔ mecânica: ${mensagemDeErro(e) ?? 'falha ao ler a leva'}\n`);
    return 2;
  }

  const alvos = agruparAlvos(pares);

  // ── camada 1b: o que o REPO diz que essas RPCs devem ser ───────────────────────────────────
  // O eixo 5 do #2428. Vem antes da sonda porque é ele que decide QUAIS nomes medir: além das RPCs
  // da leva, as irmãs da mesma migration — o conjunto acoplado que sobe num `BEGIN; … COMMIT;`.
  let corpos: CorposEsperados;
  let nomesParaSonda: string[];
  try {
    const lidas = migrationsDaRef(git, proc.sha);
    const historico = historicoDeCorpos(lidas);
    corpos = {
      historico,
      inventarioDaRef: lidas.length,
      migrationsLidas: lidas.length,
      funcoesConhecidas: historico.size,
    };
    nomesParaSonda = alvosDeCorpo(alvos, historico);
  } catch (e) {
    process.stderr.write(
      `⛔ mecânica: não consegui ler as migrations da ref (${mensagemDeErro(e) ?? 'git falhou'})\n` +
        '   sem o histórico de corpos o gate voltaria a medir só EXISTÊNCIA, que é o #2428\n',
    );
    return 2;
  }

  // ── camada 2: MEDIR em prod (o passo que o #2285 não teve) ─────────────────────────────────
  let veredito: VereditoPrecondicao;
  if (alvos.length === 0) {
    // Nenhuma RPC literal na leva. Isso NÃO é "pré-condição satisfeita" quando há indireção:
    // o extrator já disse que não enxerga tudo, e uma lista vazia por cegueira é o falso verde.
    const vazio = { ausentes: [], naoMedidos: [], desatualizadas: [], naoConferidas: [] };
    veredito =
      indirecoes > 0
        ? { ...vazio, estado: 'INCERTA', motivos: [
            `${indirecoes} chamada(s) de RPC por indireção e NENHUMA literal — a leva pode depender ` +
              'do banco sem que isto consiga dizer de quê',
          ] }
        : { ...vazio, estado: 'LIBERADA', motivos: [] };
  } else {
    let saida: string;
    try {
      saida = medir(montarSondaPrecondicao(nomesParaSonda));
    } catch (e) {
      process.stderr.write(
        `⛔ mecânica: a sonda de pré-condição não rodou (${mensagemDeErro(e) ?? 'psql falhou'})\n` +
          `   sem medir, "pode subir" seria opinião — corrija o acesso e rode de novo\n`,
      );
      return 2;
    }
    veredito = julgarPrecondicao(alvos, parsearSondaPrecondicao(saida), indirecoes, corpos);
  }

  // ── camada 3: emitir o pacote NA ORDEM, com o gate aplicado ────────────────────────────────
  const fonte: PacoteFonte = { edges: fatias, alvos, veredito, proc };
  const { texto, sha } = montarPacote(fonte);
  const destino = saidaExplicita ?? join(tmpdir(), `pacote-deploy-${sha}.md`);
  try {
    writeFileSync(destino, `${texto}\n`, 'utf8');
  } catch (e) {
    process.stderr.write(`⛔ mecânica: não consegui escrever ${destino}: ${mensagemDeErro(e) ?? '?'}\n`);
    return 2;
  }

  process.stderr.write(`${relatarPrecondicao(veredito)}\n\n`);
  process.stderr.write(
    `📦 pacote \`${sha}\` · ${fatias.length} edge(s) · ${alvos.length} RPC(s) de pré-condição\n` +
      `   ${proc.ref}@${proc.sha.slice(0, 9)}${semRede ? ' (--sem-rede: ref NÃO buscada)' : ''}\n` +
      `   ${destino}\n`,
  );

  if (veredito.estado !== 'LIBERADA') {
    process.stderr.write(
      '\n⛔ a colagem da edge NÃO foi emitida — o pacote traz só o passo de banco.\n' +
        '   Aplique a DDL, depois rode este comando de novo: o gate reabre sozinho quando prod tiver as RPCs.\n',
    );
    return 3;
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
