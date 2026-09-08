#!/usr/bin/env bun
/**
 * exclusividade-medir.ts — o MOTOR. Sabota o repo real e mede quais gates ficam vermelhos.
 * =======================================================================================
 *
 * Roda FORA do CI (caro por construcao: n defeitos x m gates). Grava
 * `scripts/exclusividade-matriz.json`, que o gate barato `bun run exclusividade` le no CI —
 * o mesmo desenho do `authz:carimbo`: medicao cara na maquina que tem o que medir, veredito
 * barato onde ele precisa bloquear.
 *
 * Uso:
 *   bun run exclusividade:medir                      # corpus inteiro x gates bloqueantes
 *   bun run exclusividade:medir -- --defeitos a,b    # so estes defeitos
 *   bun run exclusividade:medir -- --gates x,y       # so estes gates
 *   bun run exclusividade:medir -- --dry             # lista o plano e o custo, nao executa nada
 *   bun run exclusividade:medir -- --sem-poda        # nao para no 2o vermelho: quer o conjunto COMPLETO
 *
 * Exit: 0 mediu - 1 abortou (baseline sujo, arvore suja, corpus vazio) - 2 erro interno.
 *
 * ## A disciplina (herdada do mutcheck.sh, onde ja foi pensada e ja achou buraco de verdade)
 *
 *  1. ARVORE LIMPA + BASELINE VERDE. Se um gate ja esta vermelho antes da sabotagem, TODO
 *     resultado depois dele e lixo: sempre-vermelha aprova tudo. E a licao de
 *     `docs/historico/falsificacao-sem-linha-de-base.md`, e ela custou um PR inteiro.
 *  2. COPIA + trap em SIGINT/SIGTERM/uncaught. O repo NUNCA fica mutado, nem em Ctrl-C.
 *  3. GUARD ANTI-NAO-APLICACAO. perl que nao casou = INVALIDO, jamais um falso "ninguem pegou" —
 *     que e a forma mais cara de errar aqui, porque fabricaria exclusividade zero.
 *  4. SUBSTITUICAO UNICA. Sabotagem que altera >1 linha e regex largo demais (no incerto):
 *     INVALIDA. Sem isso, "o gate pegou" pode ser sobre um estrago que ninguem commitaria.
 *  5. PODA POR CUSTO, NAO POR DECLARACAO. Gates rodam do mais barato ao mais caro e a linha para
 *     no 2o vermelho — a exclusividade ja esta refutada ali. A poda NUNCA consulta `@suspeito`:
 *     deixar o autor declarar quem e "plausivel" podaria a medicao a favor de quem declara.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CORPUS_DIR,
  MATRIZ_PATH,
  SCHEMA_VERSION,
  fingerprintDefeito,
  fingerprintGate,
  fonteDoGate,
  gatesCandidatos,
  parseDefeitos,
  resumir,
  type BaselineGate,
  type Defeito,
  type ExecucaoGate,
  type GateAlvo,
  type LinhaMatriz,
  type Matriz,
} from './lib/exclusividade';

const args = process.argv.slice(2);
const flag = (n: string): string | null => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const soDefeitos = flag('--defeitos')?.split(',').map((s) => s.trim());
const soGates = flag('--gates')?.split(',').map((s) => s.trim());
const dry = args.includes('--dry');
/**
 * Desliga a poda do 2o vermelho. A poda e correta para o objetivo padrao (exclusividade ja esta
 * refutada com 2 vermelhos), mas ela responde "e exclusivo?" — nao "QUEM pega?". Investigar uma
 * duplicacao especifica ("o vitest cobre o step do docs:indice?") exige o conjunto COMPLETO, e sob
 * poda o gate caro simplesmente nunca roda. Custa a lista inteira por defeito; use dirigido.
 */
const semPoda = args.includes('--sem-poda');
const TIMEOUT_MS = Number(process.env.EXCL_TIMEOUT_MS ?? 900_000);

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
const fonteCI = readFileSync('.github/workflows/ci.yml', 'utf8');

// ---------------------------------------------------------------------------------------------
// Restauracao — registrada ANTES de qualquer mutacao, para o trap valer desde o primeiro byte
// ---------------------------------------------------------------------------------------------

const backups = new Map<string, string>();
const tmp = join(tmpdir(), `exclusividade-${process.pid}`);
mkdirSync(tmp, { recursive: true });

function restaurarTudo(): void {
  for (const [alvo, copia] of backups) {
    try {
      copyFileSync(copia, alvo);
    } catch {
      console.error(`FALHA AO RESTAURAR ${alvo} — recupere com: git checkout -- ${alvo}`);
    }
  }
  backups.clear();
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    restaurarTudo();
    process.exit(130);
  });
}
process.on('uncaughtException', (e) => {
  restaurarTudo();
  console.error(e);
  process.exit(2);
});

// ---------------------------------------------------------------------------------------------
// Execucao de um gate
// ---------------------------------------------------------------------------------------------

function rodarGate(nome: string): { reprovou: boolean; ms: number; estourou: boolean } {
  const t0 = Date.now();
  const r = spawnSync('bun', ['run', nome], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
  });
  const ms = Date.now() - t0;
  // Timeout/kill nao e "passou": e ausencia de dado. Marcamos como estourou e a linha vira invalida.
  const estourou = r.signal !== null || r.error !== undefined;
  return { reprovou: r.status !== 0, ms, estourou };
}

// ---------------------------------------------------------------------------------------------
// Sabotagem
// ---------------------------------------------------------------------------------------------

/** Aplica a expressao perl no alvo. Devolve o motivo de invalidez, ou null se aplicou limpo. */
function sabotar(d: Defeito): string | null {
  if (!existsSync(d.alvo)) return `alvo inexistente: ${d.alvo}`;

  const antes = readFileSync(d.alvo, 'utf8');
  const copia = join(tmp, d.alvo.replace(/\//g, '__'));
  mkdirSync(tmp, { recursive: true });
  copyFileSync(d.alvo, copia);
  backups.set(d.alvo, copia);

  const r = spawnSync('perl', ['-i', '-pe', d.perl, d.alvo], { encoding: 'utf8' });
  if (r.status !== 0) return `perl falhou: ${(r.stderr || '').trim().slice(0, 200)}`;

  const depois = readFileSync(d.alvo, 'utf8');
  // Guard 3: nao casou = INVALIDO. Nunca um falso "ninguem pegou".
  if (antes === depois) return 'a expressao perl NAO casou nada (regex obsoleto?)';

  // Guard 4: perturbacao MINIMA. Contamos linhas que sairam + linhas que entraram (multiset), e
  // nao "linhas na mesma posicao que diferem": comparar por posicao trata a remocao de uma unica
  // linha — a sabotagem mais natural contra um indice — como se o arquivo inteiro tivesse
  // deslizado, e barraria como "regex largo" justamente o defeito que se quer medir.
  //
  //   substituir 1 linha -> 1 saiu + 1 entrou = 2      remover 1 linha -> 1 + 0 = 1
  //   acrescentar 1 linha -> 0 + 1 = 1                 regex largo de N linhas -> 2N
  //
  // O teto de 2 admite os tres casos legitimos e ainda barra o no incerto.
  const conta = (xs: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const ca = conta(antes.split('\n'));
  const cd = conta(depois.split('\n'));
  let perturbadas = 0;
  for (const [l, n] of ca) perturbadas += Math.max(0, n - (cd.get(l) ?? 0));
  for (const [l, n] of cd) perturbadas += Math.max(0, n - (ca.get(l) ?? 0));
  if (perturbadas > 2) {
    return `a sabotagem perturbou ${perturbadas} linhas (regex largo — no incerto; o teto e 2)`;
  }

  return null;
}

function restaurar(alvo: string): void {
  const copia = backups.get(alvo);
  if (!copia) return;
  copyFileSync(copia, alvo);
  backups.delete(alvo);
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function main(): number {
  // Guard 1a: arvore limpa. Sem isso, sujeira previa fica indistinguivel da sabotagem — e a
  // restauracao por copia devolveria o arquivo ao estado sujo achando que devolveu ao limpo.
  const sujo = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim();
  if (sujo && !args.includes('--permitir-sujo')) {
    console.error('ABORTADO: arvore suja. A medicao muta arquivos reais e precisa de um estado');
    console.error('limpo para restaurar. Commite ou descarte antes (ou use --permitir-sujo se');
    console.error('as mudancas nao tocam nenhum alvo do corpus).');
    console.error(sujo.split('\n').slice(0, 10).join('\n'));
    return 1;
  }

  if (!existsSync(CORPUS_DIR)) {
    console.error(`ABORTADO: corpus ausente em ${CORPUS_DIR}/`);
    return 1;
  }
  let defeitos: Defeito[] = [];
  for (const f of readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.def')).sort()) {
    defeitos.push(...parseDefeitos(readFileSync(join(CORPUS_DIR, f), 'utf8'), join(CORPUS_DIR, f)));
  }
  if (soDefeitos) defeitos = defeitos.filter((d) => soDefeitos.includes(d.id));
  if (defeitos.length === 0) {
    console.error('ABORTADO: nenhum defeito no corpus (ou o filtro --defeitos nao casou nada).');
    return 1;
  }

  let gates: GateAlvo[] = gatesCandidatos(fonteCI).filter((g) => g.bloqueiaPR);
  if (soGates) gates = gates.filter((g) => soGates.includes(g.nome));
  if (gates.length === 0) {
    console.error('ABORTADO: nenhum gate candidato (o filtro --gates nao casou nada?).');
    return 1;
  }

  console.log(`plano: ${defeitos.length} defeito(s) x ${gates.length} gate(s) bloqueante(s)`);
  console.log(`gates: ${gates.map((g) => g.nome).join(', ')}`);
  if (dry) {
    console.log('--dry: nada foi executado.');
    return 0;
  }

  // Guard 1b: BASELINE. Todo gate candidato tem de estar VERDE no repo limpo. Isto tambem produz
  // a duracao que ordena a poda por custo.
  console.log('\nbaseline (repo limpo — todo gate precisa estar VERDE):');
  const baseline: BaselineGate[] = [];
  for (const g of gates) {
    const r = rodarGate(g.nome);
    baseline.push({ gate: g.nome, verde: !r.reprovou && !r.estourou, ms: r.ms });
    console.log(`  ${!r.reprovou && !r.estourou ? 'verde' : 'VERMELHO'}  ${g.nome.padEnd(34)} ${r.ms}ms`);
  }
  const jaVermelhos = baseline.filter((b) => !b.verde);
  if (jaVermelhos.length && !args.includes('--ignorar-baseline')) {
    console.error(`\nABORTADO: ${jaVermelhos.length} gate(s) ja vermelho(s) no repo limpo:`);
    for (const b of jaVermelhos) console.error(`  - ${b.gate}`);
    console.error('Uma linha de base vermelha aprova QUALQUER coisa depois dela — o resultado');
    console.error('seria lixo com aparencia de medicao (docs/historico/falsificacao-sem-linha-de-base.md).');
    return 1;
  }

  // Guard 5: ordem por CUSTO medido, nunca por declaracao do autor.
  const custo = new Map(baseline.map((b) => [b.gate, b.ms]));
  const ordenados = [...gates].sort((a, b) => (custo.get(a.nome) ?? 0) - (custo.get(b.nome) ?? 0));

  const fps = new Map(
    gates.map((g) => {
      const f = fonteDoGate(g.nome, pkg.scripts);
      return [g.nome, { fingerprint: fingerprintGate(f), resolvida: f.resolvida }];
    }),
  );

  const linhas: LinhaMatriz[] = [];
  for (const d of defeitos) {
    console.log(`\ndefeito ${d.id}  (alvo ${d.alvo}${d.suspeito ? `, suspeito: ${d.suspeito}` : ''})`);
    let invalido = sabotar(d);
    const execucoes: ExecucaoGate[] = [];
    let parouCedo = false;

    if (invalido) {
      console.log(`  INVALIDO: ${invalido}`);
    } else {
      let vermelhos = 0;
      for (const g of ordenados) {
        const r = rodarGate(g.nome);
        const fp = fps.get(g.nome)!;
        if (r.estourou) {
          // Estouro NAO e "o gate passou": e ausencia de dado. A linha inteira vira invalida, em
          // vez de registrar um verde que nunca foi observado.
          console.log(`  ${g.nome}: ESTOUROU o tempo — linha invalidada`);
          invalido = `gate ${g.nome} estourou o tempo (${TIMEOUT_MS}ms)`;
          break;
        }
        execucoes.push({
          gate: g.nome,
          reprovou: r.reprovou,
          ms: r.ms,
          fingerprint: fp.fingerprint,
          fonteResolvida: fp.resolvida,
        });
        if (r.reprovou) {
          vermelhos++;
          console.log(`  VERMELHO ${g.nome} (${r.ms}ms)`);
          // Poda: 2 vermelhos ja refutam exclusividade. Os demais ficam DESCONHECIDOS, e
          // `parouCedo` impede que a derivacao os leia como "nao reprovaram".
          if (vermelhos >= 2 && !semPoda) {
            parouCedo = true;
            console.log(`  (poda: 2 vermelhos, exclusividade ja refutada — ${ordenados.length - execucoes.length} gate(s) nao rodado(s))`);
            break;
          }
        }
      }
    }
    restaurar(d.alvo);
    linhas.push({
      defeito: d.id,
      defeitoFingerprint: fingerprintDefeito(d),
      alvo: d.alvo,
      suspeito: d.suspeito,
      origem: d.origem,
      execucoes,
      parouCedo,
      invalido,
    });
  }

  restaurarTudo();

  const anterior = existsSync(MATRIZ_PATH) ? (JSON.parse(readFileSync(MATRIZ_PATH, 'utf8')) as Matriz) : null;
  const matriz: Matriz = {
    schemaVersion: SCHEMA_VERSION,
    medidoEm: new Date().toISOString(),
    sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    dispensados: anterior?.dispensados ?? [],
    baseline,
    // Medicao parcial (--gates/--defeitos) ACRESCENTA, nunca apaga o que ja foi medido antes.
    linhas: [
      ...(anterior?.linhas ?? []).filter((l) => !linhas.some((n) => n.defeito === l.defeito)),
      ...linhas,
    ].sort((a, b) => a.defeito.localeCompare(b.defeito)),
  };
  writeFileSync(MATRIZ_PATH, `${JSON.stringify(matriz, null, 2)}\n`);

  console.log(`\n${resumir(matriz)}`);
  console.log(`\ngravado em ${MATRIZ_PATH}`);
  const invalidas = linhas.filter((l) => l.invalido);
  if (invalidas.length) {
    console.log(`\n${invalidas.length} linha(s) INVALIDA(s) — corrija o .def, nao sao "ninguem pegou":`);
    for (const l of invalidas) console.log(`  - ${l.defeito}: ${l.invalido}`);
  }
  return 0;
}

let codigo = 2;
try {
  codigo = main();
} finally {
  restaurarTudo();
}
process.exit(codigo);
