#!/usr/bin/env bun
/**
 * pendencias-prompt.ts — emite a COLAGEM de deploy para a leva pendente.
 *
 * O `pendencias:deploy` decide QUAIS edges precisam de deploy; a forma do prompt está medida em
 * prod (2026-09-06). Este script é o meio que faltava: monta a fatia de arquivos de cada edge e
 * emite UMA colagem para a leva inteira. Ele NÃO decide se a edge precisa de deploy — quem decide
 * é o ledger, e "o mapa mudou" não é motivo (Passo 2 da `lovable-deploy-verify`).
 *
 * A lógica pura vive em `lib/prompt-deploy.ts`. Aqui fica só a borda: argv, stdin, fs e os exits.
 *
 * Uso:
 *   bun run pendencias:prompt <edge> [edge...]              # leva explícita
 *   bun run pendencias:deploy --json | bun run pendencias:prompt -
 *
 * EXIT CODES:
 *   0  prompt emitido (stdout = a colagem; o resto vai para stderr)
 *   1  nada pendente de deploy — não há colagem a emitir
 *   2  MECÂNICA não confiável: JSON ilegível ou de outro formato, edge inexistente, import local
 *      que não resolve (a `fecharGrafo` é fail-closed), ou a auto-conferência de cobertura vermelha.
 *      Nunca imprime prompt no exit 2 — colagem incompleta é o modo de falha que este script existe
 *      para evitar (deploy parcial: boota e serve `FONTE_SHA256` velho).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  conferirCobertura,
  type EdgeParaDeploy,
  FORMATO_ACEITO,
  montarPrompt,
  selecionarParaDeploy,
} from './lib/prompt-deploy';
import { ARQ_MAPA, fecharGrafo, RAIZ_EDGES } from './sonda-fingerprint';

/**
 * A fatia que o deploy tem de nomear: fecho transitivo ∪ {mapa}.
 *
 * O mapa entra SEMPRE, mesmo em edge não instrumentada: nomear um `_shared` a mais é inócuo (ele
 * já está no bundle), enquanto omiti-lo produz deploy que boota e serve fingerprint velho. A
 * assimetria manda no default — fail-closed no lado que dói.
 */
export function fatiaDeDeploy(edge: string, raiz: string): EdgeParaDeploy {
  const entrada = `${RAIZ_EDGES}/${edge}/index.ts`;
  if (!existsSync(resolve(raiz, entrada))) {
    throw new Error(`edge inexistente na main: ${entrada}`);
  }
  const closure = fecharGrafo(entrada, raiz);
  const arquivos = [...new Set([...closure, ARQ_MAPA])].sort();
  return { edge, arquivos };
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

export function main(argv: string[], raiz = process.cwd()): number {
  const args = argv.filter((a) => a !== '');
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      'uso: bun run pendencias:prompt <edge> [edge...]\n' +
        '     bun run pendencias:deploy --json | bun run pendencias:prompt -\n',
    );
    return 2;
  }

  let nomes: string[];
  try {
    nomes = args.length === 1 && args[0] === '-' ? lerVeredito(readFileSync(0, 'utf8')) : args;
  } catch (e) {
    process.stderr.write(`⛔ mecânica: ${(e as Error).message}\n`);
    return 2;
  }

  if (nomes.length === 0) {
    process.stderr.write('✓ nada pendente de deploy — nenhuma colagem a emitir\n');
    return 1;
  }

  let leva: EdgeParaDeploy[];
  try {
    leva = nomes.map((n) => fatiaDeDeploy(n, raiz));
  } catch (e) {
    process.stderr.write(`⛔ mecânica: ${(e as Error).message}\n`);
    return 2;
  }

  const prompt = montarPrompt(leva);

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
    `✓ leva de ${leva.length} edge(s) · ${totalArquivos} arquivos · cobertura conferida\n` +
      `  Cole no chat do Lovable APÓS o merge na main. Depois: bun run sonda:sql ${nomes.join(' ')}\n\n`,
  );
  process.stdout.write(`${prompt}\n`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
