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
 *   bun run exclusividade -- --ci <arq> # so para falsificacao: le OUTRO ci.yml (ver `caminho`)
 *   bun run exclusividade -- --matriz <arq> # idem: le OUTRA matriz
 *
 * Exit: 0 sem REPROVA - 1 ha REPROVA (ou a ancora da raiz quebrou) - 2 erro do proprio gate.
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
  AUTO_MERGE_PATH,
  CI_PATH,
  MATRIZ_PATH,
  assinaturaInvocacao,
  avaliar,
  bloqueantesOpacos,
  conferirAncoraDaRaiz,
  derivar,
  fingerprintGate,
  fonteDoGate,
  gatesCandidatos,
  invocacaoDoCI,
  lerMatriz,
  resumir,
  type LeituraDaMatriz,
  type Veredito,
} from './lib/exclusividade';

const args = process.argv.slice(2);
const comoJson = args.includes('--json');
const soResumo = args.includes('--resumo');

/**
 * Caminhos sobrescritiveis SO para falsificacao: `conferirAncoraDaRaiz` mora aqui dentro, e um
 * guard que so o vitest exercita e um guard que pode nunca estar LIGADO ao exit code (a via morta
 * classica). Com `--ci`, a suite roda o BINARIO contra um `ci.yml` sabotado e cobra o vermelho de
 * verdade — no mesmo laco em que roda o `ci.yml` REAL e cobra o verde de controle.
 *
 * `--matriz` e o mesmo para a LEITURA da matriz (`lerMatriz`), mas la o controle NAO le a matriz real:
 * se lesse, o `test` viraria segunda porta do defeito `matriz-schema-futuro` do corpus.
 */
const caminho = (flag: string, padrao: string): string => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : padrao;
};

function ler(): LeituraDaMatriz {
  const arq = caminho('--matriz', MATRIZ_PATH);
  return lerMatriz(existsSync(arq) ? readFileSync(arq, 'utf8') : null);
}

/** ASCII, caixa fixa, sem acento: e o que a suite de falsificacao casa sem `-i`. */
const MARCA_ANCORA = 'ANCORA-DA-RAIZ-QUEBRADA';

function main(): number {
  const arqCI = caminho('--ci', CI_PATH);
  const arqAutoMerge = caminho('--auto-merge', AUTO_MERGE_PATH);
  const fonteCI = readFileSync(arqCI, 'utf8');

  // GUARDA ANTI-VACUO, antes de qualquer contagem e em TODOS os modos. Tem de vir aqui porque a
  // linha que este gate imprime logo abaixo — "N gate(s) bloqueante(s)" — se transforma, com a
  // raiz perdida, num "0 gate(s) bloqueante(s)" verde: a maquina inteira desligada sem uma linha
  // vermelha. Zero de bloqueante nunca e resposta; e a assinatura de que a pergunta nao foi feita.
  const ancora = conferirAncoraDaRaiz(
    fonteCI,
    existsSync(arqAutoMerge) ? readFileSync(arqAutoMerge, 'utf8') : null,
  );
  if (ancora.length > 0) {
    if (comoJson) {
      console.log(JSON.stringify({ ancoraQuebrada: ancora, vereditos: [], opacos: [], matrizPresente: null }, null, 2));
    } else {
      console.error(
        `${MARCA_ANCORA}: o required check NAO foi encontrado em ${arqCI} + ${arqAutoMerge} — esta ` +
          `maquina nao pode afirmar nada sobre exclusividade hoje. (Isto NAO significa "nenhum gate bloqueia".)`,
      );
      for (const p of ancora) console.error(`  - ${p.codigo}: ${p.motivo}`);
    }
    return 1;
  }

  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  const gates = gatesCandidatos(fonteCI);
  const leitura = ler();
  const matriz = leitura.ok ? leitura.matriz : null;

  const fps = new Map(
    gates.map((g) => {
      const f = fonteDoGate(g.nome, pkg.scripts);
      return [g.nome, { fingerprint: fingerprintGate(f), resolvida: f.resolvida }];
    }),
  );

  // A invocacao que o CI faz HOJE de cada gate. Execucao gravada com outra invocacao nao e evidencia
  // (o `tsc` era medido como `bun run tsc`, no-op); gate cuja invocacao o motor nao reproduz fica
  // sem assinatura — nenhuma execucao casa, e ele aparece como nao medido, que e a verdade.
  const bloqueantesNomes = gates.filter((g) => g.bloqueiaPR).map((g) => g.nome);
  const naoReproduziveis: string[] = [];
  const assinaturas = new Map<string, string>();
  for (const nome of bloqueantesNomes) {
    const inv = invocacaoDoCI(fonteCI, nome);
    if (inv.ok) assinaturas.set(nome, assinaturaInvocacao(inv));
    else naoReproduziveis.push(inv.motivo);
  }
  const opts = { universo: bloqueantesNomes, assinaturas };

  const vereditos: Veredito[] = avaliar(leitura, gates, fps, assinaturas);
  const opacos = bloqueantesOpacos(fonteCI);

  if (comoJson) {
    console.log(
      JSON.stringify({ ancoraQuebrada: [], vereditos, opacos, naoReproduziveis, matrizPresente: matriz !== null }, null, 2),
    );
    return vereditos.some((v) => v.severidade === 'REPROVA') ? 1 : 0;
  }

  if (soResumo) {
    if (!leitura.ok) {
      console.error(`${leitura.codigo}: ${leitura.motivo}`);
      return 2;
    }
    console.log(resumir(leitura.matriz, opts));
    return 0;
  }

  const bloqueantes = gates.filter((g) => g.bloqueiaPR).length;
  const informativos = gates.filter((g) => !g.bloqueiaPR);
  console.log(
    `exclusividade — ${bloqueantes} gate(s) bloqueante(s) no ci.yml` +
      (leitura.ok
        ? `, matriz com ${leitura.matriz.linhas.length} defeito(s) medida em ${leitura.matriz.medidoEm.slice(0, 10)}`
        : leitura.codigo === 'MATRIZ_AUSENTE'
          ? ', SEM matriz'
          : `, matriz RECUSADA (${leitura.codigo})`),
  );
  // O contador de informativos existe para o mesmo fim do `bloqueantesSemScript` do gates:frescura:
  // exclusao silenciosa le como cobertura total. `mutation-check` esta fora de `validate.needs` por
  // DESENHO (ci.yml:921) — e este gate nunca o promove a bloqueante.
  if (informativos.length) {
    console.log(`   (fora da conta, informativos por desenho: ${informativos.map((g) => g.nome).join(', ')})`);
  }
  // O segundo contador, e o que MAIS importa: estes bloqueiam o PR e nao aparecem no numero acima,
  // porque nao ha nome de script para cobrar. Sem esta linha, "N gate(s) bloqueante(s)" le como
  // cobertura total — e foi assim que `bash db/roda-nucleo-ci.sh` (#2364) entrou isento e calado.
  console.log(
    `   ${opacos.length} step(s) bloqueante(s) FORA da conta por nao invocarem script ` +
      `(sem nome de comando, o motor nao sabe roda-los):` +
      (opacos.length
        ? `\n${opacos.map((o) => `     - ${o.job}: ${o.step}\n       $ ${o.comando}`).join('\n')}`
        : ' (nenhum)'),
  );
  // O terceiro contador: gate nomeado cuja invocacao do CI o motor nao reproduz (step composto,
  // env com expressao, invocado de dois jeitos). Ele esta no numero acima, mas nao ha como media-lo.
  console.log(
    `   ${naoReproduziveis.length} gate(s) bloqueante(s) com invocacao do CI NAO reproduzivel pelo motor` +
      (naoReproduziveis.length ? `:\n${naoReproduziveis.map((m) => `     - ${m}`).join('\n')}` : ' (nenhum)'),
  );

  const ordem = { REPROVA: 0, AVISA: 1, RELATA: 2 } as const;
  for (const v of [...vereditos].sort((a, b) => ordem[a.severidade] - ordem[b.severidade])) {
    console.log(`  ${v.severidade.padEnd(7)} ${v.gate.padEnd(34)} ${v.codigo}\n            ${v.motivo}`);
  }

  if (matriz) {
    const semExclusivo = derivar(matriz, opts).filter((e) => e.pegou.length > 0 && e.exclusivos.length === 0);
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
