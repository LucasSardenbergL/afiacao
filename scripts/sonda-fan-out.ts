#!/usr/bin/env bun
/**
 * sonda-fan-out.ts — quem muda `_shared/` vê, NO PR, quais edges vão virar DIVERGE_P2 — e decide P1 ali.
 * ============================================================================================
 *
 * ## O buraco que ele tapa (medido, não suposto — 2026-09-05)
 *
 * Em 11 dias: 24 PRs tocaram edges, 42 bumps legítimos de `versao.ts`, **66** mudanças de `fonte`
 * — **22 pedidos de deploy só por fan-out de `_shared/`, sem a edge mudar, 18 de um único PR
 * (#2132)**. A mecânica que produz isso é correta e deliberada, e por isso ninguém a viu:
 *
 *   · o gate `sonda:bump` deixa `_shared/` FORA de propósito (~12 bumps à mão por PR — medição no
 *     cabeçalho dele; precisão > recall);
 *   · o `sonda:fingerprint --write` regenera o mapa em SILÊNCIO — o `fonte` das 18 edges muda, o
 *     CI fica verde, e o autor do PR que mudou `_shared/x.ts` nunca fica sabendo QUAIS edges
 *     passaram a divergir de prod, nem se alguma delas merecia bump.
 *
 * A decisão P1/P2 (`scripts/lib/pendencias-deploy.ts`) é tomada DEPOIS, por outra sessão, lendo o
 * ledger: `fonte` diferente com `VERSAO` igual = DIVERGE_P2 (pendente NÃO declarado, leva
 * agrupada); com `VERSAO` diferente = DIVERGE_P1 (comportamento declarado, deploy no PR). Quem
 * muda `_shared/` QUERENDO mudar o comportamento da edge X deveria bumpar a X na hora — mas só
 * decide quem enxerga, e o autor não enxergava.
 *
 * ## O que este script é — e o que NÃO é
 *
 * É INFORMAÇÃO, não gate: exit 0 com ou sem achados; exit 2 só por MECÂNICA (base que não
 * resolve, git que falha). Nunca reprova o PR. A razão é a mesma que tirou `_shared/` do
 * `sonda:bump`: aviso que grita 12× por PR treina a ignorar. O bloco é curto (uma linha por edge),
 * ASCII, caixa fixa nos rótulos (`BUMP`/`SEM_BUMP`/`NOVA`/`ILEGIVEL`) — grep exato, sem `-i`.
 *
 * ## A régua
 *
 *   (1) `_shared/` ALTERADO = `git diff --name-status base..HEAD -- supabase/functions/_shared`,
 *       menos `*_test.ts`/`*.test.ts` (nunca entram em fecho) e menos o próprio mapa
 *       `_shared/sonda-fingerprints.ts` (é a SAÍDA: muda em toda fatia que muda qualquer coisa, e
 *       está fora de todo fecho por construção — ponto-fixo).
 *   (2) CONSUMIDORA de um arquivo = edge INSTRUMENTADA (tem `versao.ts`) cujo fecho transitivo no
 *       HEAD contém o arquivo. O fecho vem da `fecharGrafo` de `sonda-fingerprint.ts` — a MESMA
 *       que produz o `fonte` servido. Reimplementar a varredura aqui criaria duas noções de "o que
 *       entra no bundle" que divergem em silêncio (a razão de `parsearMapa` viver lá).
 *   (3) STATUS da edge = `VERSAO` na base vs no HEAD, lidos com a `extrairVersao` do `sonda:bump`
 *       (a MESMA régua de marcador): `BUMP` (P1), `SEM_BUMP` (vira P2 no `pendencias:deploy`),
 *       `NOVA` (nasce instrumentada na fatia — o marcador inicial já a nomeia), `ILEGIVEL`
 *       (`export const VERSAO` ilegível no HEAD — vence `NOVA`: nascer sem marcador legível não é
 *       nascer instrumentada).
 *
 * Universo = edges instrumentadas, porque `fonte` só existe para elas. Edge FORA do mapa que
 * importa `_shared/` é a classe cega do `edges:afetadas` (via c) — outra pergunta, outro script.
 *
 * ## Por que módulo próprio, e não um bloco dentro do `sonda-fingerprint.ts`
 *
 * O fingerprint é gate de ESTADO: roda em TODO evento (push do Lovable, cron da main) e não
 * precisa de base. Este precisa do DIFF — é da família do `sonda:bump` (`pull_request`-only, base =
 * merge-base). Além disso, `sonda-fingerprint.ts` é a fonte do `fecharGrafo` que este módulo
 * consome: importar de volta seria ciclo. O fingerprint aponta para cá na mensagem de falha.
 *
 * ## Limites (declarados, não escondidos)
 *
 *   · o fecho é o do HEAD: arquivo de `_shared/` REMOVIDO sai como `removido`, consumidoras=0 — a
 *     edge que o importava teve de mudar o próprio `index.ts`, e isso é território do `sonda:bump`;
 *   · sem `--head`, o HEAD é a ÁRVORE DE TRABALHO (como no `sonda:bump`): arquivo novo ainda
 *     untracked não entra no `git diff`;
 *   · `fonte` é identidade da FONTE, não hash do bundle — a ⚠️ do cabeçalho do fingerprint vale aqui.
 *
 * ## Calibração (o número que este script tem de reproduzir)
 *
 *   bun scripts/sonda-fan-out.ts --base 5362ec761^ --head 5362ec761     # o #2132
 *   → 3 arquivo(s) de _shared/, 20 edge(s): SEM_BUMP=18 BUMP=2 — os mesmos 18 medidos à mão.
 *
 * Uso:
 *   bun run sonda:fanout                                   # base = merge-base (GITHUB_BASE_REF → origin/main → main)
 *   bun scripts/sonda-fan-out.ts --base <rev> [--head <rev>]
 *   SONDA_BASE=<rev> bun run sonda:fanout
 *
 * Exit: 0 = mediu (com ou sem achados) · 2 = mecânica (não medi; não é "nada mudou").
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { materializar } from './edges-afetadas';
import { ARQ_MAPA, ARQ_MARCADOR, RAIZ_EDGES, edgesInstrumentadas, ehTeste, fecharGrafo, parsearMapa } from './sonda-fingerprint';
import { extrairVersao, git, resolverBase } from './sonda-versao-bump-gate';

const ROTULO = 'sonda-fan-out';

/** Prefixo com `/` no fim: fronteira de SEGMENTO — `_shared-x/` não é `_shared/`. */
export const PREFIXO_SHARED = `${RAIZ_EDGES}/_shared/`;

/** O caminho é um arquivo de `_shared/` cuja mudança altera o `fonte` de alguém? */
export function contaComoShared(caminho: string): boolean {
  if (!caminho.startsWith(PREFIXO_SHARED)) return false;
  if (caminho === ARQ_MAPA) return false;
  return !ehTeste(caminho);
}

export interface ArquivoAlterado {
  /** relativo à raiz do repo */
  caminho: string;
  /** o diff diz `D`: o arquivo não existe mais no HEAD */
  removido: boolean;
}

export interface EdgeNaFatia {
  edge: string;
  /** fecho transitivo no HEAD, relativo ao repo; null = não fechou */
  fecho: string[] | null;
  /** por que não fechou (quando `fecho === null`) */
  erroFecho: string | null;
  /** `VERSAO` na base; null = a edge não era instrumentada lá */
  versaoBase: string | null;
  /** `VERSAO` no HEAD; null = marcador ilegível */
  versaoHead: string | null;
}

export type Status = 'BUMP' | 'SEM_BUMP' | 'NOVA' | 'ILEGIVEL';

export interface LinhaArquivo {
  caminho: string;
  removido: boolean;
  /** edges instrumentadas cujo fecho contém o arquivo, ordenadas */
  consumidoras: string[];
}

export interface LinhaEdge {
  edge: string;
  status: Status;
  versaoBase: string | null;
  versaoHead: string | null;
  /** os arquivos de `_shared/` alterados que estão no fecho desta edge, ordenados */
  causas: string[];
}

export interface Relatorio {
  arquivos: LinhaArquivo[];
  edges: LinhaEdge[];
  avisos: string[];
}

/** `ILEGIVEL` vence `NOVA`: sem marcador legível, a sonda não prova bundle nenhum. */
export function classificar(versaoBase: string | null, versaoHead: string | null): Status {
  if (versaoHead === null) return 'ILEGIVEL';
  if (versaoBase === null) return 'NOVA';
  return versaoBase === versaoHead ? 'SEM_BUMP' : 'BUMP';
}

/**
 * Núcleo puro: cruza os arquivos de `_shared/` alterados com o fecho de cada edge instrumentada.
 *
 * O `contaComoShared` é reaplicado aqui de propósito, mesmo com o coletor já filtrando: a regra
 * mora no núcleo, senão um chamador futuro monta a entrada sem o filtro e o bloco passa a listar
 * `*_test.ts` — ruído com o mesmo desfecho do sinal (mesma razão do `auditarBump`).
 *
 * Ordenação por `.sort()` puro (ordem de code unit), NÃO por `localeCompare`: o resultado tem de
 * ser o mesmo em `LC_ALL=C` e em `pt_BR.UTF-8` (#1483).
 */
export function calcularFanOut(alterados: ArquivoAlterado[], edges: EdgeNaFatia[]): Relatorio {
  const mudados = alterados
    .filter((a) => contaComoShared(a.caminho))
    .sort((a, b) => (a.caminho < b.caminho ? -1 : a.caminho > b.caminho ? 1 : 0));
  if (mudados.length === 0) return { arquivos: [], edges: [], avisos: [] };

  const mudou = new Set(mudados.map((a) => a.caminho));
  const consumidoras = new Map<string, string[]>(mudados.map((a) => [a.caminho, []]));
  const linhas: LinhaEdge[] = [];
  const avisos: string[] = [];

  for (const e of [...edges].sort((a, b) => (a.edge < b.edge ? -1 : a.edge > b.edge ? 1 : 0))) {
    if (e.fecho === null) {
      avisos.push(
        `${e.edge}: fecho ilegivel (${e.erroFecho ?? 'sem mensagem'}) - nao consegui atribuir; ` +
          'o sonda:fingerprint reprova este caso',
      );
      continue;
    }
    const causas = e.fecho.filter((f) => mudou.has(f)).sort();
    if (causas.length === 0) continue;
    for (const c of causas) consumidoras.get(c)?.push(e.edge);
    linhas.push({
      edge: e.edge,
      status: classificar(e.versaoBase, e.versaoHead),
      versaoBase: e.versaoBase,
      versaoHead: e.versaoHead,
      causas,
    });
  }

  return {
    arquivos: mudados.map((a) => ({
      caminho: a.caminho,
      removido: a.removido,
      consumidoras: consumidoras.get(a.caminho) ?? [],
    })),
    edges: linhas,
    avisos,
  };
}

// ─── Renderização: ASCII, caixa fixa, uma linha por edge ─────────────────────────────────────

/** `supabase/functions/_shared/x.ts` → `_shared/x.ts` — o prefixo é o mesmo em toda linha. */
function curto(caminho: string): string {
  return caminho.startsWith(`${RAIZ_EDGES}/`) ? caminho.slice(RAIZ_EDGES.length + 1) : caminho;
}

function versoes(e: LinhaEdge): string {
  switch (e.status) {
    case 'BUMP':
      return `${e.versaoBase} -> ${e.versaoHead}`;
    case 'SEM_BUMP':
      return `${e.versaoBase} (mesmo da base)`;
    case 'NOVA':
      return `(nasce nesta fatia) -> ${e.versaoHead}`;
    case 'ILEGIVEL':
      return `${e.versaoBase ?? '(sem base)'} -> ? (VERSAO ilegivel no HEAD)`;
  }
}

/**
 * O bloco que o autor lê. Tudo ASCII imprimível: sem acento, seta ou check — para caber em log
 * de CI, ser grepado exato e não depender de fonte/terminal.
 */
export function renderizar(rel: Relatorio, fatia: string): string[] {
  if (rel.arquivos.length === 0) {
    return [
      `${ROTULO}: fatia ${fatia}: nenhum arquivo de _shared/ mudou (fora testes e o mapa gerado) - nada a informar`,
    ];
  }
  const linhas: string[] = [
    `${ROTULO}: fatia ${fatia}: ${rel.arquivos.length} arquivo(s) de _shared/ mudaram, ` +
      `${rel.edges.length} edge(s) instrumentada(s) com fonte alterado por _shared/`,
  ];

  const largArq = Math.max(...rel.arquivos.map((a) => curto(a.caminho).length));
  for (const a of rel.arquivos) {
    const nome = curto(a.caminho).padEnd(largArq);
    if (a.removido) linhas.push(`  ${nome}  removido (fora de todo fecho no HEAD)`);
    else if (a.consumidoras.length === 0) linhas.push(`  ${nome}  consumidoras=0 (fora de todo fecho instrumentado)`);
    else linhas.push(`  ${nome}  consumidoras=${a.consumidoras.length}: ${a.consumidoras.join(',')}`);
  }

  const largEdge = Math.max(0, ...rel.edges.map((e) => e.edge.length));
  const largVer = Math.max(0, ...rel.edges.map((e) => versoes(e).length));
  for (const e of rel.edges) {
    linhas.push(
      `  ${e.status.padEnd(8)}  ${e.edge.padEnd(largEdge)}  ${versoes(e).padEnd(largVer)}  por ${e.causas.map(curto).join(',')}`,
    );
  }

  const conta = (s: Status): number => rel.edges.filter((e) => e.status === s).length;
  linhas.push(
    `  resumo: BUMP=${conta('BUMP')} (P1: comportamento declarado, deploy no PR) ` +
      `SEM_BUMP=${conta('SEM_BUMP')} (P2: fonte muda sem VERSAO, vira DIVERGE_P2 no pendencias:deploy, leva agrupada) ` +
      `NOVA=${conta('NOVA')} ILEGIVEL=${conta('ILEGIVEL')}`,
  );
  if (conta('SEM_BUMP') > 0) {
    linhas.push(
      '  decida agora: SEM_BUMP cujo comportamento muda com esta fatia merece bump do VERSAO (vira P1). ' +
        'Informativo: este passo nunca reprova.',
    );
  }
  return linhas;
}

// ─── I/O: git ────────────────────────────────────────────────────────────────────────────────

/** git com `-C repo`: o coletor é parametrizado pelo repo para o teste montar o dele num tmpdir. */
function gitEm(repo: string, args: string[]): { ok: boolean; saida: string } {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, saida: (r.stdout ?? '').replace(/\n$/, '') };
}

function lerNaRevEm(repo: string, rev: string, caminho: string): string | null {
  const r = gitEm(repo, ['show', `${rev}:${caminho}`]);
  return r.ok ? r.saida : null;
}

function lerNaArvore(repo: string, caminho: string): string | null {
  const abs = resolve(repo, caminho);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

/**
 * Os arquivos de `_shared/` que a fatia alterou. `rev === null` no HEAD = árvore de trabalho.
 *
 * `--no-renames` de propósito: com detecção de renome o git imprime `R100\told\tnovo`, e um
 * renome é, para o fecho, um removido mais um novo — que é exatamente como sai sem a detecção.
 */
export function alteradosEmShared(repo: string, base: string, headRev: string | null): ArquivoAlterado[] {
  const args = ['diff', '--name-status', '--no-renames', base];
  if (headRev) args.push(headRev);
  args.push('--', `${RAIZ_EDGES}/_shared`);
  const { ok, saida } = gitEm(repo, args);
  // ⚠️ Status descartado seria lista vazia por ERRO lida como lista vazia por MÉRITO — o furo #1 do
  // `sonda:bump`. Aqui a consequência é menor (é informação), mas "nada mudou" continua sendo
  // mentira quando o comando nem rodou.
  if (!ok) {
    throw new Error(`\`git ${args.join(' ')}\` falhou - sem diff nao ha o que medir, e nao medir nao e "nada mudou"`);
  }
  const alterados: ArquivoAlterado[] = [];
  for (const linha of saida.split('\n')) {
    if (linha === '') continue;
    const [status, caminho] = linha.split('\t');
    if (!status || !caminho) throw new Error(`linha inesperada no \`git diff --name-status\`: ${JSON.stringify(linha)}`);
    if (!contaComoShared(caminho)) continue;
    alterados.push({ caminho, removido: status.startsWith('D') });
  }
  return alterados;
}

export interface Coleta {
  alterados: ArquivoAlterado[];
  edges: EdgeNaFatia[];
}

/**
 * Coleta a fatia: diff de `_shared/`, fecho e `VERSAO` de cada edge instrumentada no HEAD.
 *
 * Com `headRev`, o HEAD é MATERIALIZADO (`git archive`, como no `edges:afetadas`) — nunca a
 * árvore de trabalho, senão `--head <rev>` mediria o que está no disco e não a rev pedida. Sem
 * `headRev`, o HEAD é a árvore (a régua do `sonda:bump`).
 *
 * Fecho que não fecha numa edge NÃO derruba a coleta: a edge sai com `erroFecho` e as outras
 * medem. O gate que reprova esse caso é o `sonda:fingerprint`; aqui ele vira aviso nominal.
 */
export function coletarFanOut(repo: string, base: string, headRev: string | null): Coleta {
  const alterados = alteradosEmShared(repo, base, headRev);
  if (alterados.length === 0) return { alterados, edges: [] };

  const raizHead = headRev ? materializar(repo, headRev) : repo;
  try {
    const edges: EdgeNaFatia[] = edgesInstrumentadas(raizHead).map((edge) => {
      let fecho: string[] | null = null;
      let erroFecho: string | null = null;
      try {
        fecho = fecharGrafo(`${RAIZ_EDGES}/${edge}/index.ts`, raizHead);
      } catch (e) {
        erroFecho = mensagemDeErro(e) ?? 'erro sem mensagem';
      }
      const marcador = `${RAIZ_EDGES}/${edge}/${ARQ_MARCADOR}`;
      const fonteBase = lerNaRevEm(repo, base, marcador);
      const fonteHead = headRev ? lerNaRevEm(repo, headRev, marcador) : lerNaArvore(repo, marcador);
      return {
        edge,
        fecho,
        erroFecho,
        versaoBase: fonteBase === null ? null : extrairVersao(fonteBase),
        versaoHead: fonteHead === null ? null : extrairVersao(fonteHead),
      };
    });
    return { alterados, edges };
  } finally {
    if (headRev) rmSync(raizHead, { recursive: true, force: true });
  }
}

// ─── Prova pelo LEDGER (vigia do Publish, rodada 2 / M1) ──────────────────────────────────────
//
// O vigia (`scripts/lovable-publish.sh --decidir`) exigia `liberar` humano para TODO arquivo de
// `_shared/` no intervalo ar..main — e o mapa `_shared/sonda-fingerprints.ts` muda em todo PR de
// edge (RETIDO manual de 74 min em 27/11). O `pendencias:deploy` compara `(versao, fonte)` servido ×
// main, e `fonte` é o hash do FECHO, `_shared/` incluído: para uma edge DO MAPA, o ledger já prova a
// mudança de `_shared/`. Não prova para quem está FORA dele — edge sem `versao.ts` ou que não entrou
// no mapa importando o arquivo. Esta prova diz qual dos dois casos é a fatia.
//
// Universo = TODA edge com `index.ts` (não só as instrumentadas: é justamente a não-instrumentada que
// o ledger não vê). Fail-closed: fecho ilegível em qualquer edge = não sei quem consome = sem prova.

export interface EdgeParaProva {
  edge: string;
  fecho: string[] | null;
  erroFecho: string | null;
  /** tem `versao.ts` no HEAD */
  instrumentada: boolean;
  /** está no mapa de fingerprints do HEAD */
  noMapa: boolean;
}

export interface ProvaLedger {
  /** true = toda consumidora dos arquivos alterados é instrumentada E está no mapa */
  prova: boolean;
  /** `LEDGER <edge> <causas>` · `FORA_DO_MAPA <edge> <causas>` · `ILEGIVEL <edge> <erro>` · `SEM_CONSUMIDORA <arq>` */
  linhas: string[];
}

export function provaPeloLedger(alterados: ArquivoAlterado[], edges: EdgeParaProva[]): ProvaLedger {
  const mudados = alterados.filter((a) => contaComoShared(a.caminho)).map((a) => a.caminho).sort();
  if (mudados.length === 0) return { prova: true, linhas: [] };
  const mudou = new Set(mudados);
  const consumido = new Set<string>();
  const linhas: string[] = [];
  let prova = true;
  for (const e of [...edges].sort((a, b) => (a.edge < b.edge ? -1 : a.edge > b.edge ? 1 : 0))) {
    if (e.fecho === null) {
      prova = false;
      linhas.push(`ILEGIVEL ${e.edge} ${(e.erroFecho ?? 'sem mensagem').replace(/\s+/g, ' ').slice(0, 160)}`);
      continue;
    }
    // `consome`, não `causas`: o .mut do calcularFanOut casa a linha `const causas = …` pelo texto (contrato único)
    const consome = e.fecho.filter((arq) => mudou.has(arq)).sort();
    if (consome.length === 0) continue;
    for (const c of consome) consumido.add(c);
    const rot = e.instrumentada && e.noMapa ? 'LEDGER' : 'FORA_DO_MAPA';
    if (rot === 'FORA_DO_MAPA') prova = false;
    linhas.push(`${rot} ${e.edge} ${consome.map(curto).join(',')}`);
  }
  for (const m of mudados) if (!consumido.has(m)) linhas.push(`SEM_CONSUMIDORA ${curto(m)}`);
  return { prova, linhas };
}

/** Todas as edges com `index.ts` numa raiz materializada. */
function todasAsEdges(raiz: string): string[] {
  const base = resolve(raiz, RAIZ_EDGES);
  return readdirSync(base)
    .filter((n) => n !== '_shared' && statSync(join(base, n)).isDirectory() && existsSync(join(base, n, 'index.ts')))
    .sort();
}

export function coletarProvaLedger(repo: string, base: string, headRev: string): ProvaLedger {
  const alterados = alteradosEmShared(repo, base, headRev);
  if (alterados.length === 0) return { prova: true, linhas: [] };
  const raiz = materializar(repo, headRev);
  try {
    const instr = new Set(edgesInstrumentadas(raiz));
    const mapa = parsearMapa(lerNaRevEm(repo, headRev, ARQ_MAPA) ?? '');
    const edges: EdgeParaProva[] = todasAsEdges(raiz).map((edge) => {
      let fecho: string[] | null = null;
      let erroFecho: string | null = null;
      try {
        fecho = fecharGrafo(`${RAIZ_EDGES}/${edge}/index.ts`, raiz);
      } catch (e) {
        erroFecho = mensagemDeErro(e) ?? 'erro sem mensagem';
      }
      return { edge, fecho, erroFecho, instrumentada: instr.has(edge), noMapa: edge in mapa };
    });
    return provaPeloLedger(alterados, edges);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
}

/**
 * `--prova-ledger --base <ar> --head <main>`: última linha `PROVA_LEDGER=0` (o ledger prova toda
 * mudança de `_shared/` da fatia) ou `PROVA_LEDGER=1` (há consumidora fora do mapa, ou fecho
 * ilegível). Exit 0 = mediu (qualquer das duas) · 2 = mecânica (o vigia trata como sem prova).
 */
function mainProvaLedger(base: string | null, headArg: string | null): number {
  if (base === null || !headArg) {
    console.log('PROVA_LEDGER_MECANICA: --prova-ledger exige --base e --head resolvíveis');
    return 2;
  }
  const r = git(['rev-parse', '--verify', `${headArg}^{commit}`]);
  if (!r.ok) {
    console.log(`PROVA_LEDGER_MECANICA: --head ${headArg} nao resolve`);
    return 2;
  }
  let p: ProvaLedger;
  try {
    p = coletarProvaLedger(process.cwd(), base, r.saida);
  } catch (e) {
    console.log(`PROVA_LEDGER_MECANICA: ${(mensagemDeErro(e) ?? 'erro sem mensagem').slice(0, 200)}`);
    return 2;
  }
  for (const l of p.linhas) console.log(l);
  console.log(`PROVA_LEDGER=${p.prova ? 0 : 1}`);
  return 0;
}

export function main(argv: string[]): number {
  if (argv.includes('--prova-ledger')) {
    const ib = argv.indexOf('--base');
    const ih = argv.indexOf('--head');
    const b = ib >= 0 ? argv[ib + 1] : undefined;
    const bres = b ? git(['rev-parse', '--verify', `${b}^{commit}`]) : { ok: false, saida: '' };
    return mainProvaLedger(bres.ok ? bres.saida : null, ih >= 0 ? (argv[ih + 1] ?? null) : null);
  }
  const iBase = argv.indexOf('--base');
  const iHead = argv.indexOf('--head');
  const baseArg = iBase >= 0 ? argv[iBase + 1] : process.env.SONDA_BASE;
  const headArg = iHead >= 0 ? (argv[iHead + 1] ?? null) : null;

  // A base é a MESMA noção de fatia do `sonda:bump` (resolverBase é dele): dois gates que medem a
  // mesma fatia contra bases diferentes apareceriam como um verde e um vermelho no mesmo PR.
  const base = resolverBase(baseArg);
  if (base === null) {
    console.error(
      `${ROTULO}: nao medido - a BASE nao resolve (${baseArg ? `--base ${baseArg}` : 'tentei GITHUB_BASE_REF, origin/main, main'}).\n` +
        '  Local: `git fetch origin main`, ou passe `--base <rev>`. No CI: checkout com `fetch-depth: 0`.\n' +
        '  Exit 2 = mecanica, nao achado: nao medir nao e o mesmo que "nada mudou".',
    );
    return 2;
  }

  let headRev: string | null = null;
  if (iHead >= 0) {
    const r = headArg ? git(['rev-parse', '--verify', `${headArg}^{commit}`]) : { ok: false, saida: '' };
    if (!r.ok) {
      console.error(
        `${ROTULO}: nao medido - \`--head ${headArg ?? '<sem valor>'}\` nao resolve para um commit. ` +
          'Rev que nao resolve devolveria diff vazio, e diff vazio se leria como "nada mudou".',
      );
      return 2;
    }
    headRev = r.saida;
  }

  let coleta: Coleta;
  try {
    coleta = coletarFanOut(process.cwd(), base, headRev);
  } catch (e) {
    console.error(`${ROTULO}: nao medido - ${mensagemDeErro(e) ?? 'erro sem mensagem'}`);
    return 2;
  }

  const rel = calcularFanOut(coleta.alterados, coleta.edges);
  const fatia = `${base.slice(0, 9)}..${headRev ? headRev.slice(0, 9) : 'arvore-de-trabalho'}`;
  for (const a of rel.avisos) console.error(`${ROTULO}: aviso: ${a}`);
  for (const l of renderizar(rel, fatia)) console.log(l);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
