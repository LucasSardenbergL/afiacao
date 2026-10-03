#!/usr/bin/env bun
/**
 * mutcheck-escopo.ts — quais contratos de mutação ESTE diff alcança.
 * ============================================================================================
 *
 * O job `mutation-check` (ci.yml) rodava os 48 contratos `scripts/mutcheck.d/*.mut` em SÉRIE a
 * cada push de PR: 30–43 min por push em 2026-10-01, num job que NÃO é required (o merge não
 * espera por ele). Medido nos runs de 25/09 a 01/10: ele sozinho ocupou **39%** de todo o tempo
 * de runner do repo — e o plano Free tem 20 jobs simultâneos, então esse tempo vira FILA para os
 * jobs que barram o merge. Nos 300 PRs mergeados mais recentes, só **27%** tocaram algum arquivo
 * que um contrato mede.
 *
 * Um contrato só muda de veredito quando muda (a) o fonte que ele muta (`# @src:`), (b) o teste
 * que tem de matar a mutação (`# @test:`), (c) o próprio `.mut`, ou (d) a maquinaria comum —
 * os GATILHOS_GLOBAIS abaixo. Fora disso o PR não tem o que medir ali.
 *
 * Decisão por evento:
 *  - `pull_request` → só os contratos alcançados pelo diff do merge commit (pai 1 → HEAD).
 *    Gatilho global → TODOS. Nenhum alcançado → o job fica SKIPPED (pulado, não verde).
 *  - qualquer outro evento (push/workflow_dispatch na main) → TODOS, como sempre. É a rede: o
 *    que escapar do escopo (ex.: helper de teste compartilhado que o contrato não declara)
 *    aparece no run da main, onde o sensor abre a Issue `mutcheck-cobertura`.
 *
 * Fail-CLOSED em toda incerteza: merge commit sem 2 pais, diff ilegível, nenhum contrato
 * legível ⇒ TODOS; contrato sem alvo declarado ⇒ ele roda. Pular por incerteza seria verde por
 * ausência de dado. Pelo mesmo motivo o script NUNCA sai ≠ 0 — erro vira "roda TODOS".
 *
 * PARTES (2026-10-03): TODOS levava ~43 min em série, contra o teto de 60. Agora TODOS vira 3
 * partes da matriz do `mutation-check`, equilibradas pelo custo ESTIMADO de cada contrato
 * (`estimarCusto` → `repartir`, determinístico); o escopo de um PR cabe numa parte só. Cada parte
 * recalcula a repartição e mede só a sua fatia; o job `mutcheck-sensor` (main) recalcula de novo
 * e confere a UNIÃO dos resumos (`juntar`): cada contrato medido exatamente uma vez. Parte sem
 * resumo, contrato sem medição ou medido duas vezes ⇒ `incompleto` ⇒ o alarme da Issue
 * `mutcheck-cobertura` dispara — ausência de dado não fecha Issue nenhuma.
 *
 * Uso (CI, ver ci.yml):
 *   bun run mutcheck:escopo --evento "$EVENTO" --github-output                          # mutcheck-escopo
 *   bun run mutcheck:escopo --evento "$EVENTO" --materializar <dir> --parte "$I/$N"     # mutation-check
 *   bun run mutcheck:escopo --evento "$EVENTO" --juntar <dir> --partes "$VETOR" \
 *     --saida <arquivo> --github-output                                                 # mutcheck-sensor
 * Local (o que um PR desta branch rodaria):
 *   bun run mutcheck:escopo --base origin/main --head HEAD
 *
 * Só builtins + `@/lib/erro-mensagem` (sem import de pacote): o job de escopo não paga `bun install`.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mensagemDeErro } from '@/lib/erro-mensagem';

export const DIR_CONTRATOS = 'scripts/mutcheck.d';

/**
 * Mudar qualquer um destes pode mudar o veredito de QUALQUER contrato ⇒ roda todos.
 * A ferramenta (`mutcheck.sh`/`mutcheck-all.sh`), este seletor, a prova por consumidor que roda
 * no mesmo job, a definição do job (`ci.yml`), a resolução das dependências (`bun.lock` — inclui o
 * vitest) e a configuração/setup do vitest que todo teste de `src/`/`scripts/` herda.
 * Arquivo de apoio dentro de `scripts/mutcheck.d/` que não seja `.mut` também conta (ver
 * `selecionar`). Renomear um destes sem atualizar a lista só tira PRECISÃO: o run da main segue
 * rodando todos. Por isso não há gate cobrando a lista (regra de máquina meta do CLAUDE.md).
 */
export const GATILHOS_GLOBAIS: readonly string[] = [
  'scripts/mutcheck.sh',
  'scripts/mutcheck-all.sh',
  'scripts/mutcheck-escopo.ts',
  'scripts/prova-consumidores-controle.sh',
  '.github/workflows/ci.yml',
  'bun.lock',
  'vitest.config.ts',
  'src/test/setup.ts',
  'src/test/setup-dom.ts',
];

export interface Contrato {
  /** caminho do `.mut`, relativo à raiz do repo */
  mut: string;
  /** caminhos de `# @src:` e `# @test:` — o que o contrato MEDE */
  alvos: string[];
  /** custo ESTIMADO em segundos (ver `estimarCusto`) — só decide o equilíbrio das partes */
  custo: number;
}

export interface Selecao {
  /** true = roda TODOS os contratos (gatilho global, evento fora de PR, ou não consegui decidir) */
  todos: boolean;
  /** `.mut` selecionados quando `todos` é false; vazio + todos=false ⇒ nada a medir */
  contratos: string[];
  /** uma linha por motivo, para o log do job */
  motivos: string[];
}

/** Mesmo parse do `mutcheck-all.sh` (`sed -n 's/^#[[:space:]]*@src:…'`), mas colhendo TODAS as linhas. */
const RE_ALVO = /^#\s*@(src|test):\s*(\S+)\s*$/;

function normaliza(p: string): string {
  return p.trim().replace(/^\.\//, '');
}

export function lerContrato(mut: string, texto: string): Contrato {
  const alvos: string[] = [];
  for (const linha of texto.split('\n')) {
    const m = linha.match(RE_ALVO);
    if (m) alvos.push(normaliza(m[2]));
  }
  return { mut, alvos, custo: estimarCusto(texto) };
}

/** Uma linha de mutação do `.mut`: `PEGA | descrição | perl` ou `SOBREVIVE | …` (cada uma = 1 rodada da suíte). */
const RE_MUTACAO = /^(PEGA|SOBREVIVE)\s*\|/;

/**
 * Segundos por rodada da suíte, medianas do log da main de 2026-10-01 (48 contratos): o custo de um
 * contrato é ~(nº de mutações + baseline) × o custo de UMA rodada, e a rodada depende do runner. O
 * nº de mutações sozinho já correlaciona 0,90 com a duração; com o peso por runner, a maior das 3
 * partes simuladas ficou em 15,6 min contra o ótimo de 14,1. Errar aqui só desequilibra as partes —
 * nunca tira um contrato da medição.
 */
export const SEGUNDOS_POR_RODADA = {
  bash: 0.7,
  deno: 1.7,
  /** vitest com o `@test` em `scripts/`: suítes dos gates, que leem o repo */
  vitestScripts: 2.7,
  /** vitest com o `@test` em `src/` (o default do `mutcheck.sh`) */
  vitestSrc: 1.2,
} as const;

export function estimarCusto(texto: string): number {
  let mutacoes = 0;
  let runner = '';
  let teste = '';
  for (const linha of texto.split('\n')) {
    if (RE_MUTACAO.test(linha)) mutacoes++;
    const cmd = linha.match(/^#\s*@test_cmd:\s*(\S+)/);
    if (cmd && !runner) runner = cmd[1];
    const t = linha.match(RE_ALVO);
    if (t && t[1] === 'test' && !teste) teste = normaliza(t[2]);
  }
  const porRodada =
    runner === 'bash'
      ? SEGUNDOS_POR_RODADA.bash
      : runner === 'deno'
        ? SEGUNDOS_POR_RODADA.deno
        : teste.startsWith('scripts/')
          ? SEGUNDOS_POR_RODADA.vitestScripts
          : SEGUNDOS_POR_RODADA.vitestSrc;
  return (mutacoes + 1) * porRodada;
}

/**
 * Reparte os contratos em `n` partes equilibradas pelo custo estimado (LPT: o mais caro primeiro,
 * sempre na parte mais leve). DETERMINÍSTICO — empate por nome e pelo menor índice —, porque cada
 * parte da matriz recalcula a mesma repartição sozinha, e o agregador também: a mesma entrada tem
 * de dar a mesma divisão nos três lugares, ou um contrato cairia em duas partes ou em nenhuma.
 */
export function repartir(contratos: readonly Contrato[], n: number): Contrato[][] {
  const partes: Contrato[][] = Array.from({ length: Math.max(1, Math.floor(n)) }, () => []);
  const somas = partes.map(() => 0);
  const ordem = [...contratos].sort((a, b) => b.custo - a.custo || a.mut.localeCompare(b.mut));
  for (const c of ordem) {
    let k = 0;
    for (let i = 1; i < partes.length; i++) if (somas[i] < somas[k]) k = i;
    partes[k].push(c);
    somas[k] += c.custo;
  }
  return partes;
}

/** Quantas partes: TODOS (main, gatilho global) vira 3; o escopo de um PR cabe numa. */
export const PARTES_TODOS = 3;

export function partesDe(sel: Selecao): number {
  return sel.todos ? PARTES_TODOS : 1;
}

/** O conjunto que a seleção manda medir, como contratos (com custo): todos, ou só os escolhidos. */
export function universo(sel: Selecao, contratos: readonly Contrato[]): Contrato[] {
  if (sel.todos) return [...contratos];
  const escolhidos = new Set(sel.contratos);
  return contratos.filter((c) => escolhidos.has(c.mut));
}

export function roda(sel: Selecao): boolean {
  return sel.todos || sel.contratos.length > 0;
}

/** Função PURA: o diff (lista de caminhos) × os contratos → o que medir. */
export function selecionar(mudados: readonly string[], contratos: readonly Contrato[]): Selecao {
  const arquivos = new Set(mudados.map(normaliza).filter(Boolean));

  const globais = [...arquivos].filter(
    (f) => GATILHOS_GLOBAIS.includes(f) || (f.startsWith(`${DIR_CONTRATOS}/`) && !f.endsWith('.mut')),
  );
  if (globais.length > 0) {
    return {
      todos: true,
      contratos: [],
      motivos: globais.map((f) => `${f}: gatilho global — vale para todo contrato`),
    };
  }

  const contratosSel: string[] = [];
  const motivos: string[] = [];
  for (const c of contratos) {
    if (c.alvos.length === 0) {
      contratosSel.push(c.mut);
      motivos.push(`${c.mut}: sem '# @src:'/'# @test:' — escopo desconhecido, roda (fail-closed)`);
      continue;
    }
    const toques = [c.mut, ...c.alvos].filter((p) => arquivos.has(p));
    if (toques.length > 0) {
      contratosSel.push(c.mut);
      motivos.push(`${c.mut}: alcançado por ${[...new Set(toques)].join(', ')}`);
    }
  }
  return { todos: false, contratos: contratosSel, motivos };
}

/**
 * Evento + entradas que podem ter falhado (`null` = não consegui ler) → seleção. Toda leitura
 * que falhou vira TODOS: aqui "não sei" nunca pode virar "pula".
 */
export function decidir(
  evento: string,
  mudados: readonly string[] | null,
  contratos: readonly Contrato[] | null,
): Selecao {
  if (evento !== 'pull_request') {
    return { todos: true, contratos: [], motivos: [`evento '${evento}' — fora de PR roda TODOS (é a rede da main)`] };
  }
  if (mudados === null) {
    return { todos: true, contratos: [], motivos: ['diff ilegível — sem escopo, roda TODOS (fail-closed)'] };
  }
  if (contratos === null || contratos.length === 0) {
    return {
      todos: true,
      contratos: [],
      motivos: [`nenhum contrato legível em ${DIR_CONTRATOS} — roda TODOS (fail-closed)`],
    };
  }
  return selecionar(mudados, contratos);
}

/**
 * Linhas `chave=valor` para o `$GITHUB_OUTPUT` do job de escopo. `partes` é o vetor da matriz do
 * `mutation-check` — nunca vazio (matriz vazia não sobe, nem para ficar SKIPPED).
 */
export function linhasDeSaida(sel: Selecao): string[] {
  const partes = Array.from({ length: partesDe(sel) }, (_, i) => i + 1);
  return [
    `roda=${roda(sel)}`,
    `todos=${sel.todos}`,
    `contratos=${sel.contratos.join(' ')}`,
    `partes=${JSON.stringify(partes)}`,
  ];
}

export interface Parte {
  /** 1-based, como o `matrix.parte` do ci.yml */
  i: number;
  /** total de partes da matriz (`strategy.job-total`) */
  n: number;
}

/**
 * Monta o diretório que o `mutcheck-all.sh` lê via `MUTCHECK_DIR` (o mesmo mecanismo que o teste
 * do sensor usa), com um symlink por contrato. Devolve o diretório — ou `null` quando o certo é
 * rodar TODOS (então o `MUTCHECK_DIR` não é definido e o default vale).
 *
 * Com uma parte só, é o escopo do diff (TODOS ⇒ `null`). Com `n` partes, é a fatia `i` de
 * `repartir(universo)` — inclusive em TODOS: cada parte mede só a sua fatia. Fatia vazia ainda
 * devolve o diretório (vazio): a parte não roda nada, e o agregador sabe que não devia.
 */
export function materializar(
  sel: Selecao,
  destino: string,
  parte: Parte = { i: 1, n: 1 },
  contratos: readonly Contrato[] = [],
): string | null {
  if (!Number.isInteger(parte.i) || !Number.isInteger(parte.n) || parte.i < 1 || parte.i > parte.n) {
    throw new Error(`parte inválida: ${parte.i}/${parte.n}`);
  }
  let fatia: string[];
  if (parte.n === 1) {
    if (sel.todos || sel.contratos.length === 0) return null;
    fatia = sel.contratos;
  } else {
    const base = universo(sel, contratos);
    // Sem contratos legíveis não há como repartir: rodar todos nesta parte é caro, mas mede.
    if (base.length === 0) return null;
    fatia = repartir(base, parte.n)[parte.i - 1].map((c) => c.mut);
  }
  mkdirSync(destino, { recursive: true });
  for (const mut of fatia) symlinkSync(resolve(mut), join(destino, basename(mut)));
  return destino;
}

/** Uma linha do resumo que o `mutcheck-all.sh` grava em `MUTCHECK_RESUMO`. */
export interface ResumoContrato {
  mut: string;
  exit: number;
  invalidas: number;
  divergencias: number;
  abortou: boolean;
  sumario: string;
}

export interface Resumo {
  total: number;
  com_problema: number;
  contratos: ResumoContrato[];
}

export interface Juncao {
  resumo: Resumo & {
    partes: number;
    partes_sem_resumo: number[];
    faltando: string[];
    duplicados: string[];
    inesperados: string[];
  };
  /** true = a medição NÃO cobriu exatamente o que devia — ausência de dado, não aprovação */
  incompleto: boolean;
  motivos: string[];
}

/**
 * A UNIÃO das partes: cada contrato esperado medido exatamente uma vez. `esperado` é a repartição
 * recalculada pelo agregador (a mesma de cada parte); `lidos` são os resumos que as partes
 * subiram. Parte com fatia não vazia e sem resumo, contrato que ninguém mediu, contrato medido
 * duas vezes ou fora da fatia de quem o mediu ⇒ `incompleto`.
 */
export function juntar(esperado: readonly Contrato[][], lidos: ReadonlyMap<number, Resumo>): Juncao {
  const nome = (m: string) => basename(m);
  const motivos: string[] = [];
  const partesSemResumo = esperado
    .map((fatia, k) => (fatia.length > 0 && !lidos.has(k + 1) ? k + 1 : 0))
    .filter((k) => k > 0);
  for (const k of partesSemResumo) motivos.push(`parte ${k}/${esperado.length}: sem resumo — ela não chegou a medir`);

  const vezes = new Map<string, number>();
  const inesperados: string[] = [];
  const contratos: ResumoContrato[] = [];
  let total = 0;
  let comProblema = 0;
  for (const [k, r] of [...lidos].sort((a, b) => a[0] - b[0])) {
    const daFatia = new Set((esperado[k - 1] ?? []).map((c) => nome(c.mut)));
    total += r.total;
    comProblema += r.com_problema;
    for (const c of r.contratos) {
      const n = nome(c.mut);
      vezes.set(n, (vezes.get(n) ?? 0) + 1);
      if (!daFatia.has(n)) inesperados.push(`${n} (parte ${k})`);
      contratos.push({ ...c, mut: `${DIR_CONTRATOS}/${n}` });
    }
  }
  const duplicados = [...vezes].filter(([, v]) => v > 1).map(([n]) => n);
  // O contrato de uma parte SEM resumo já está dito no motivo dela; aqui só o que sumiu de parte que rodou.
  const daParteMuda = new Set(partesSemResumo.flatMap((k) => (esperado[k - 1] ?? []).map((c) => nome(c.mut))));
  const faltando = esperado
    .flat()
    .map((c) => nome(c.mut))
    .filter((n) => !vezes.has(n) && !daParteMuda.has(n));
  if (faltando.length) motivos.push(`sem medição (a parte rodou, o contrato não): ${faltando.join(', ')}`);
  if (duplicados.length) motivos.push(`medidos mais de uma vez: ${duplicados.join(', ')}`);
  if (inesperados.length) motivos.push(`fora da fatia de quem os mediu: ${inesperados.join(', ')}`);

  return {
    resumo: {
      total,
      com_problema: comProblema,
      contratos,
      partes: esperado.length,
      partes_sem_resumo: partesSemResumo,
      faltando,
      duplicados,
      inesperados,
    },
    incompleto: partesSemResumo.length + faltando.length + duplicados.length + inesperados.length > 0,
    motivos,
  };
}

export function lerContratos(dir: string = DIR_CONTRATOS): Contrato[] | null {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.mut'))
      .sort()
      .map((f) => {
        const mut = `${dir}/${f}`;
        return lerContrato(mut, readFileSync(mut, 'utf8'));
      });
  } catch {
    return null;
  }
}

/**
 * Os dois pais do merge commit que o `actions/checkout` faz no `pull_request` (refs/pull/N/merge):
 * pai 1 = a base no instante do merge de teste, HEAD = o resultado. O diff entre eles é EXATAMENTE
 * o que o PR muda na main. Precisa de `fetch-depth: 2`. Sem 2 pais ⇒ `null` (fail-closed).
 */
export function paisDoMerge(): { base: string; head: string } | null {
  try {
    const shas = execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { encoding: 'utf8' })
      .trim()
      .split(/\s+/);
    return shas.length === 3 ? { base: shas[1], head: shas[0] } : null;
  } catch {
    return null;
  }
}

export function arquivosMudados(base: string, head: string): string[] | null {
  try {
    // -z + quotePath=false: caminho cru, sem as aspas/escapes que o git põe em nome com acento.
    // --no-renames: rename vira remoção + adição, então o caminho ANTIGO também alcança o contrato.
    const out = execFileSync(
      'git',
      ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', base, head],
      { encoding: 'utf8' },
    );
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function escrever(arquivo: string | undefined, linhas: string[]): void {
  if (!arquivo) throw new Error('variável de ambiente do GitHub ausente');
  appendFileSync(arquivo, `${linhas.join('\n')}\n`);
}

/** `--parte 2/3` → { i: 2, n: 3 }; ausente → parte única. Malformado lança (o catch roda TODOS). */
export function lerParte(texto: string | undefined): Parte {
  if (texto === undefined) return { i: 1, n: 1 };
  const m = texto.match(/^(\d+)\/(\d+)$/);
  if (!m) throw new Error(`--parte malformado: '${texto}' (esperado i/n)`);
  return { i: Number(m[1]), n: Number(m[2]) };
}

/** `--partes '[1,2,3]'` (o vetor da matriz) → 3. Ilegível lança — sempre com a marca do guard,
 *  inclusive quando é o `JSON.parse` que falha (ausente, não-JSON), para o log nomear a flag. */
export function contarPartes(texto: string | undefined): number {
  let v: unknown;
  try {
    v = JSON.parse(texto ?? '');
  } catch (e) {
    throw new Error(`--partes ilegível: '${texto}' (${mensagemDeErro(e) ?? 'JSON inválido'})`);
  }
  if (!Array.isArray(v) || v.length === 0) throw new Error(`--partes ilegível: '${texto}'`);
  return v.length;
}

/** Lê `parte-<k>.json` de `dir` (o download dos artefatos). JSON ilegível conta como ausente. */
export function lerResumos(dir: string): Map<number, Resumo> {
  const lidos = new Map<number, Resumo>();
  let nomes: string[] = [];
  try {
    nomes = readdirSync(dir);
  } catch {
    return lidos;
  }
  for (const f of nomes) {
    const m = f.match(/^parte-(\d+)\.json$/);
    if (!m) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Resumo;
      if (Array.isArray(r.contratos)) lidos.set(Number(m[1]), r);
    } catch {
      /* ausente para o agregador: a parte vira "sem resumo" */
    }
  }
  return lidos;
}

if (import.meta.main) {
  const querSaida = process.argv.includes('--github-output');
  const destino = arg('--materializar');
  const dirJuntar = arg('--juntar');
  try {
    const evento = arg('--evento') ?? 'pull_request';
    let mudados: string[] | null = null;
    if (evento === 'pull_request') {
      const base = arg('--base');
      const par = base ? { base, head: arg('--head') ?? 'HEAD' } : paisDoMerge();
      mudados = par ? arquivosMudados(par.base, par.head) : null;
    }
    const contratos = lerContratos();
    const sel = decidir(evento, mudados, contratos);

    if (dirJuntar) {
      // Agregador: recalcula a MESMA repartição das partes e confere a união contra os resumos.
      const saida = arg('--saida');
      if (!saida) throw new Error('--juntar exige --saida <arquivo>');
      const n = contarPartes(arg('--partes'));
      const j = juntar(repartir(universo(sel, contratos ?? []), n), lerResumos(dirJuntar));
      writeFileSync(saida, JSON.stringify(j.resumo));
      for (const m of j.motivos) console.log(`  · ${m}`);
      console.log(
        j.incompleto
          ? `mutcheck-escopo: união INCOMPLETA em ${n} parte(s) — ausência de dado, não aprovação.`
          : `mutcheck-escopo: união completa — ${j.resumo.contratos.length} contrato(s) medido(s) uma vez cada, em ${n} parte(s).`,
      );
      if (querSaida) escrever(process.env.GITHUB_OUTPUT, [`incompleto=${j.incompleto}`]);
      process.exit(0);
    }

    for (const m of sel.motivos) console.log(`  · ${m}`);
    if (sel.todos) console.log('mutcheck-escopo: TODOS os contratos.');
    else if (sel.contratos.length > 0) console.log(`mutcheck-escopo: ${sel.contratos.length} contrato(s) no escopo deste diff.`);
    else console.log('mutcheck-escopo: nenhum contrato no escopo deste diff — o mutation-check fica pulado (a main roda TODOS).');

    if (querSaida) escrever(process.env.GITHUB_OUTPUT, linhasDeSaida(sel));
    if (destino) {
      const parte = lerParte(arg('--parte'));
      const dir = materializar(sel, destino, parte, contratos ?? []);
      if (dir) {
        escrever(process.env.GITHUB_ENV, [`MUTCHECK_DIR=${dir}`]);
        console.log(`mutcheck-escopo: parte ${parte.i}/${parte.n} → MUTCHECK_DIR com ${readdirSync(dir).length} contrato(s).`);
      }
    }
  } catch (e) {
    // Fail-closed. Job de escopo: registra "roda TODOS numa parte só"; se nem isso der, a condição
    // do `mutation-check` (`roda != 'false'`) roda mesmo assim. Materializar: não definir o
    // MUTCHECK_DIR JÁ é rodar todos. Agregador: a união fica INCOMPLETA — o alarme dispara.
    console.log(`::warning::mutcheck-escopo não decidiu (${mensagemDeErro(e) ?? 'erro desconhecido'}) — vale o lado seguro.`);
    if (querSaida && process.env.GITHUB_OUTPUT) {
      try {
        appendFileSync(
          process.env.GITHUB_OUTPUT,
          dirJuntar ? 'incompleto=true\n' : 'roda=true\ntodos=true\ncontratos=\npartes=[1]\n',
        );
      } catch {
        /* a condição dos jobs já trata saída ausente como o lado seguro */
      }
    }
  }
  process.exit(0);
}
