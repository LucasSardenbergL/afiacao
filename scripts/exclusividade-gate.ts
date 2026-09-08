#!/usr/bin/env bun
/**
 * exclusividade-gate.ts — o GATE barato. Le a matriz medida e da veredito. Roda no CI.
 * ===================================================================================
 *
 * Nao executa gate nenhum e nao sabota nada: le `scripts/exclusividade-matriz.json`, compara com
 * o `ci.yml` de hoje e responde a unica pergunta que torna a criacao de um gate nao-gratuita:
 *
 *     este gate bloqueante tem ALGUM defeito que so ele pega?
 *
 * Uso:
 *   bun run exclusividade              # veredito (step do CI)
 *   bun run exclusividade -- --json    # veredito estruturado
 *   bun run exclusividade -- --resumo  # a matriz inteira em forma humana
 *
 * Exit: 0 sem REPROVA - 1 ha REPROVA - 2 erro do proprio gate.
 *
 * ## Por que ele SEMPRE imprime os tres niveis, inclusive o que nao bloqueia
 *
 * Mesma razao do `authz-carimbo-gate.ts`: um gate que silencia o que nao pune ensina que o eixo
 * nao existe. REPROVA/AVISA/RELATA e escolha de SEVERIDADE, nunca de visibilidade — e aqui o
 * RELATA (exclusividade zero medida) e justamente o achado mais valioso do arquivo, o que nunca
 * deve bloquear ninguem e nunca deve sumir.
 */
import { existsSync, readFileSync } from 'node:fs';

import {
  MATRIZ_PATH,
  avaliar,
  derivar,
  fingerprintGate,
  fonteDoGate,
  gatesCandidatos,
  resumir,
  type Matriz,
  type Veredito,
} from './lib/exclusividade';

const args = process.argv.slice(2);
const comoJson = args.includes('--json');
const soResumo = args.includes('--resumo');

function ler(): Matriz | null {
  if (!existsSync(MATRIZ_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MATRIZ_PATH, 'utf8')) as Matriz;
  } catch {
    // Ilegivel e indistinguivel de ausente para efeito de evidencia — os dois sao fail-closed.
    return null;
  }
}

function main(): number {
  const fonteCI = readFileSync('.github/workflows/ci.yml', 'utf8');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  const gates = gatesCandidatos(fonteCI);
  const matriz = ler();

  const fps = new Map(
    gates.map((g) => {
      const f = fonteDoGate(g.nome, pkg.scripts);
      return [g.nome, { fingerprint: fingerprintGate(f), resolvida: f.resolvida }];
    }),
  );

  const vereditos: Veredito[] = avaliar(matriz, gates, fps);

  if (comoJson) {
    console.log(JSON.stringify({ vereditos, matrizPresente: matriz !== null }, null, 2));
    return vereditos.some((v) => v.severidade === 'REPROVA') ? 1 : 0;
  }

  if (soResumo) {
    if (!matriz) {
      console.error(`sem matriz em ${MATRIZ_PATH}`);
      return 2;
    }
    console.log(resumir(matriz));
    return 0;
  }

  const bloqueantes = gates.filter((g) => g.bloqueiaPR).length;
  const informativos = gates.filter((g) => !g.bloqueiaPR);
  console.log(
    `exclusividade — ${bloqueantes} gate(s) bloqueante(s) no ci.yml` +
      (matriz ? `, matriz com ${matriz.linhas.length} defeito(s) medida em ${matriz.medidoEm.slice(0, 10)}` : ', SEM matriz'),
  );
  // O contador de informativos existe para o mesmo fim do `bloqueantesSemScript` do gates:frescura:
  // exclusao silenciosa le como cobertura total. `mutation-check` esta fora de `validate.needs` por
  // DESENHO (ci.yml:921) — e este gate nunca o promove a bloqueante.
  if (informativos.length) {
    console.log(`   (fora da conta, informativos por desenho: ${informativos.map((g) => g.nome).join(', ')})`);
  }

  const ordem = { REPROVA: 0, AVISA: 1, RELATA: 2 } as const;
  for (const v of [...vereditos].sort((a, b) => ordem[a.severidade] - ordem[b.severidade])) {
    console.log(`  ${v.severidade.padEnd(7)} ${v.gate.padEnd(34)} ${v.codigo}\n            ${v.motivo}`);
  }

  if (matriz) {
    const semExclusivo = derivar(matriz).filter((e) => e.pegou.length > 0 && e.exclusivos.length === 0);
    if (!vereditos.length) console.log('  nenhum veredito acionavel.');
    if (semExclusivo.length) {
      console.log(
        `\n   ${semExclusivo.length} gate(s) sem contribuicao exclusiva NESTE corpus de ${matriz.linhas.length} defeito(s).` +
          `\n   Isto NAO os condena: corpus curto nao mede gate raro (docs:links tem dez achados no proprio historico).` +
          `\n   E um convite a escrever o defeito que so ele pegaria — ou a cortar, com a evidencia na mao.`,
      );
    }
  }

  return vereditos.some((v) => v.severidade === 'REPROVA') ? 1 : 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error('exclusividade: erro do proprio gate (exit 2):', e instanceof Error ? e.message : e);
  process.exit(2);
}
