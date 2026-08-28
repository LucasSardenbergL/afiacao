#!/usr/bin/env bun
/**
 * authz-carimbo-gate.ts — GATE que lê o carimbo. Roda no CI (que não tem banco) e no laptop.
 *
 * Uso:
 *   bun run authz:carimbo                     → só os eixos que BLOQUEIAM PR (step do `validate`)
 *   bun run authz:carimbo -- --exigir-frescor → + idade e achado vivo (job `authz-sentinela`, main)
 *   bun run authz:carimbo -- --json           → veredito estruturado (o job usa para montar a Issue)
 *
 * Exit: 0 sem veredito acionável no modo pedido · 1 há veredito · 2 erro do próprio gate.
 *
 * ⚠️ O gate SEMPRE IMPRIME os quatro eixos, mesmo os que não bloqueiam no modo corrente. Um gate
 * que silencia o que não pune ensina que o eixo não existe — e o modo do chamador é uma escolha de
 * SEVERIDADE, não de visibilidade. A divisão em si (o que bloqueia PR e o que não) está explicada
 * em `scripts/lib/authz-carimbo.ts`; em uma frase: PR só é barrado pelo que um PR consegue
 * consertar.
 */
import { existsSync, readFileSync } from 'node:fs';

import {
  AUDITS,
  AVISO_DIAS,
  CARIMBO_PATH,
  VENCIDO_DIAS,
  avaliarCarimbo,
  fingerprintsAtuais,
  type Carimbo,
  type Veredito,
} from './lib/authz-carimbo';

const args = process.argv.slice(2);
const exigirFrescor = args.includes('--exigir-frescor');
const comoJson = args.includes('--json');

function ler(): Carimbo | null {
  if (!existsSync(CARIMBO_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CARIMBO_PATH, 'utf8')) as Carimbo;
  } catch {
    return null; // ilegível é indistinguível de ausente para efeito de evidência — os dois são fail-closed
  }
}

let vereditos: Veredito[];
try {
  vereditos = avaliarCarimbo(ler(), new Date(), fingerprintsAtuais());
} catch (e) {
  // Erro do GATE (ex.: contrato com valor que `canonicalizar` não representa) é exit 2 — distinto
  // de "há veredito". Um gate que não conseguiu avaliar não pode sair 0.
  console.error(`❌ authz:carimbo — falha ao avaliar: ${(e as Error).message}`);
  process.exit(2);
}

if (comoJson) {
  // `audits` viaja no payload para o corpo da Issue NÃO escrever a contagem à mão. Ela já
  // apodreceu uma vez: o texto dizia "três FATIAS" depois que o 4º e o 5º audit entraram —
  // e a mensagem errada é justamente a que chega ao founder no momento do alarme.
  console.log(
    JSON.stringify(
      { exigirFrescor, avisoDias: AVISO_DIAS, vencidoDias: VENCIDO_DIAS, audits: Object.keys(AUDITS), vereditos },
      null,
      2,
    ),
  );
}

const bloqueantes = vereditos.filter((v) => v.bloqueiaPR);
const informativos = vereditos.filter((v) => !v.bloqueiaPR);

if (!comoJson) {
  for (const v of bloqueantes) console.error(`❌ [${v.codigo}] ${v.mensagem}`);
  for (const v of informativos) {
    const punindo = exigirFrescor && v.codigo !== 'CARIMBO_AVISO';
    console.error(`${punindo ? '❌' : '⚠️ '} [${v.codigo}] ${v.mensagem}`);
  }
  if (vereditos.length === 0) {
    console.log(`✅ authz:carimbo — evidência de prod fresca (≤ ${VENCIDO_DIAS}d), contrato e auditores batem, nenhum achado aberto.`);
  }
}

const acionaveis = exigirFrescor
  ? vereditos.filter((v) => v.codigo !== 'CARIMBO_AVISO')
  : bloqueantes;
process.exit(acionaveis.length > 0 ? 1 : 0);
