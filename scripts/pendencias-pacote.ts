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

import { coletarDaEdge } from './lib/edge-rpcs';
import {
  agruparAlvos,
  julgarPrecondicao,
  montarSondaPrecondicao,
  parsearSondaPrecondicao,
  relatarPrecondicao,
  type VereditoPrecondicao,
} from './lib/precondicao-banco';
import { FORMATO_ACEITO, type Procedencia, selecionarParaDeploy } from './lib/prompt-deploy';
import {
  arvoreDaRef,
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

export function main(argv: string[], raiz = process.cwd(), git = gitBytes(raiz)): number {
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

  const iSaida = args.indexOf('--saida');
  const saidaExplicita = iSaida >= 0 ? args[iSaida + 1] : undefined;
  if (iSaida >= 0 && saidaExplicita === undefined) {
    process.stderr.write('⛔ mecânica: --saida sem caminho\n');
    return 2;
  }
  const nomesArg = args.filter((_, i) => i !== iSaida && i !== iSaida + 1);

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
    process.stderr.write('✓ nada pendente de deploy — nenhum pacote a emitir\n');
    return 1;
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
    const arvore = arvoreDaRef(REF_DEPLOYADA, git);
    fatias = nomes.map((edge) => {
      const achado = coletarDaEdge(edge, raiz);
      for (const r of achado.rpcs) pares.push({ edge, rpc: r.nome });
      indirecoes += achado.indirecoes.length;
      return { ...fatiaDeDeploy(edge, raiz, arvore), rpcs: achado.rpcs.map((r) => r.nome).sort() };
    });
  } catch (e) {
    process.stderr.write(`⛔ mecânica: ${mensagemDeErro(e) ?? 'falha ao ler a leva'}\n`);
    return 2;
  }

  const alvos = agruparAlvos(pares);

  // ── camada 2: MEDIR em prod (o passo que o #2285 não teve) ─────────────────────────────────
  let veredito: VereditoPrecondicao;
  if (alvos.length === 0) {
    // Nenhuma RPC literal na leva. Isso NÃO é "pré-condição satisfeita" quando há indireção:
    // o extrator já disse que não enxerga tudo, e uma lista vazia por cegueira é o falso verde.
    veredito =
      indirecoes > 0
        ? { estado: 'INCERTA', ausentes: [], naoMedidos: [], motivos: [
            `${indirecoes} chamada(s) de RPC por indireção e NENHUMA literal — a leva pode depender ` +
              'do banco sem que isto consiga dizer de quê',
          ] }
        : { estado: 'LIBERADA', ausentes: [], naoMedidos: [], motivos: [] };
  } else {
    let saida: string;
    try {
      saida = medirEmProd(montarSondaPrecondicao(alvos.map((a) => a.rpc)));
    } catch (e) {
      process.stderr.write(
        `⛔ mecânica: a sonda de pré-condição não rodou (${mensagemDeErro(e) ?? 'psql falhou'})\n` +
          `   sem medir, "pode subir" seria opinião — corrija o acesso e rode de novo\n`,
      );
      return 2;
    }
    veredito = julgarPrecondicao(alvos, parsearSondaPrecondicao(saida), indirecoes);
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
