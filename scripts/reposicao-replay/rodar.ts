// Orquestração do replay TSB (plano, Task 9): `bun scripts/reposicao-replay/rodar.ts [--dados DIR] [--saida ARQ] [--paralelo N]`.
//   1. carrega os dados e monta a coorte;
//   2. calibra o F0 (só o alvo) e F1–F3 (calibracao.ts);
//   3. escolhe e CONGELA a candidata (os parâmetros saem da calibração e não são tocados depois);
//   4. avalia F0 e a candidata em LT × falta × estado inicial, mais "todos os ativos" e "com substituição";
//   5. aumenta as replicações (200, +100) até a meia largura MC alvo ou o teto de 1.000;
//   6. aplica a tabela de decisão (estatistica.ts) e escreve o relatório em $REPLAY_DADOS (NUNCA no repositório).
// Sai ≠ 0 só em erro de dado (ErroDadosReplay) ou erro do simulador; NO-GO e INCONCLUSIVO não são erro.
//
// Paralelismo: as replicações são independentes (aleatoriedade por chave, sem estado entre reps). O processo principal
// pré-computa as grades (cache em disco) e reparte cada lote de reps entre N processos filhos (`--lote`), que devolvem
// SOMAS (não médias) e as métricas por rep; a soma de lotes é exata. A precisão nunca é reduzida por tempo.
//
// DECISÕES DOCUMENTADAS (Task 9):
//  · O bootstrap recebe a MÉDIA das replicações (uma SomasSemanais): fill, estoque médio e custo líquido da média são
//    idênticos aos agregados sobre as reps (Σ/Σ, dias corridos iguais em todas), e o custo fica O(semanas) por reamostragem.
//  · Clopper-Pearson: linhas = contagem OBSERVADA da célula (igual em todas as reps) e sucessos = fill observado × linhas
//    (nunca a soma sobre as reps, que estreitaria o intervalo).
//  · Critério 3 e a redução do estresse nos TRÊS cenários de falta (R25). Critério 5 só com a taxa de 25% (R26); 20% e 30%
//    são sensibilidade no relatório.
//  · Meia largura MC = 1,96·s/√n das DIFERENÇAS pareadas por rep (Δ fill nas 6 células; redução de estoque), máximo sobre os
//    cenários que entram nos critérios (estado reconstruído, LT empírico e estresse, 3 faltas).
//  · "Todos os ativos" e "Calibração" entram como linhas extras da tabela: veredito diferente entre as coortes ou classe não
//    observável na calibração ⇒ INCERTO (spec §5.1.1 e §5.9).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { CenarioLT } from './aleatorio';
import {
  avaliarNaCalibracao,
  baseDaCalibracao,
  calibrar,
  CLASSES,
  escolherCandidata,
  estoqueDaJanela,
  vereditoDaCalibracao,
  fillDaCelula,
  mapaMisto,
  mediaSomas,
  REPS_CALIBRACAO,
  somarSomas,
  type ResultadoCalibracao,
} from './calibracao';
import { CENARIOS_FALTA, GRADE_CUSTO, GRADE_QUANTIS, JANELAS, NOME_METRICA_SERVICO, PRECISAO, TSB } from './config';
import { carregarDados } from './dados';
import {
  avaliarCriterios,
  bootstrapPareado,
  estatCusto,
  estatDeltaFillRate,
  estatFillRate,
  estatReducaoCapital,
  indicesBlocosCirculares,
  meiaLarguraMC,
  veredito,
  type Criterio,
  type EstatisticaPareada,
} from './estatistica';
import { hashCodigo, parametrosNoDia, paridadeF0, preComputar, preComputarComOrigem, type Formula, type ParamsDia, type ParamsFormula } from './formulas';
import { custoFaltaEquilibrio, custoLiquido, type GradeCusto } from './metricas';
import { coorte, coorteTodosAtivos } from './parados';
import { diagnosticoEstadoInicial, negativosNaAvaliacao, type CenarioInicial } from './reconstrucao';
import { escreverRelatorio, type Rodada } from './relatorio';
import { CELULAS, paridadeQuantidade, simular, type Celula, type Falta, type SomasSemanais } from './simulador';
import {
  ErroDadosReplay,
  type BlocoBootstrap,
  type Classe,
  type Dados,
  type Evidencia,
  type EvidenciaServico,
  type Intervalo,
  type IntervaloPorBloco,
  type VereditoReplay,
} from './tipos';

// ── cenários ────────────────────────────────────────────────────────────────────────────────────────────────────
export type Populacao = 'coorte' | 'todos';
export interface Cenario {
  pop: Populacao;
  inicial: CenarioInicial;
  lt: CenarioLT;
  falta: Falta;
  sub: boolean;
}
export const chaveCenario = (c: Cenario): string => `${c.pop}|${c.inicial}|${c.lt}|${c.falta}|${c.sub ? 'sub' : 'exato'}`;
const FALTAS: readonly Falta[] = ['espera', 'cancelamento', 'misto'];
const LTS: readonly CenarioLT[] = ['empirico', 'estresse15', 'choque29'];
const INICIAIS: readonly CenarioInicial[] = ['reconstruido', 'piso_zero'];

export function cenariosDaAvaliacao(): Cenario[] {
  const out: Cenario[] = [];
  for (const inicial of INICIAIS) for (const lt of LTS) for (const falta of FALTAS) out.push({ pop: 'coorte', inicial, lt, falta, sub: false });
  for (const falta of CENARIOS_FALTA.servico) out.push({ pop: 'coorte', inicial: 'reconstruido', lt: 'empirico', falta, sub: true });
  for (const lt of ['empirico', 'estresse15'] as const) for (const falta of FALTAS) out.push({ pop: 'todos', inicial: 'reconstruido', lt, falta, sub: false });
  return out;
}
/** Cenários cuja meia largura MC é controlada (os que entram nos critérios do veredito principal). */
const naPrecisao = (c: Cenario): boolean => c.pop === 'coorte' && c.inicial === 'reconstruido' && !c.sub && c.lt !== 'choque29';
const CELULAS_SERVICO: readonly Celula[] = ['A', 'B', 'C', 'A_alt', 'B_alt', 'C_alt'];

// ── mapas congelados ──────────────────────────────────────────────────────────────────────────────────────────────
export interface Congelado {
  candidata: Formula;
  params: ParamsFormula;
}
interface Mapas {
  coorte: { f0: Map<string, ParamsDia>; alt: Map<string, ParamsDia> };
  todos: { f0: Map<string, ParamsDia>; alt: Map<string, ParamsDia> };
}
const QUANTIL_NEUTRO: ParamsFormula = { quantil: { A: 0.95, B: 0.95, C: 0.95 } };

/** Parâmetros na avaliação (todos os ativos, até o fim da avaliação). cacheDir: null = sem disco; ausente = $REPLAY_DADOS/cache. */
function preAval(f: Formula, dados: Dados, p: ParamsFormula, cacheDir: string | null | undefined): Map<string, ParamsDia> {
  return preComputarComOrigem(f, dados, p, { calibracao: false }, cacheDir === undefined ? {} : { cacheDir }).mapa;
}

function mapasDaAvaliacao(dados: Dados, cg: Congelado, cacheDir?: string | null): Mapas {
  const f0 = preAval('F0', dados, QUANTIL_NEUTRO, cacheDir);
  const fn = preAval(cg.candidata, dados, cg.params, cacheDir);
  const c = coorte(dados);
  const t = coorteTodosAtivos(dados);
  return {
    coorte: { f0: mapaMisto(f0, null, c.populacao, c.alterados), alt: mapaMisto(f0, fn, c.populacao, c.alterados) },
    todos: { f0: mapaMisto(f0, null, t.populacao, t.alterados), alt: mapaMisto(f0, fn, t.populacao, t.alterados) },
  };
}

// ── lote de replicações ─────────────────────────────────────────────────────────────────────────────────────────
export interface Lote {
  n: number;
  /** Somas (não médias) por cenário. */
  somas: Record<string, { f0: SomasSemanais; alt: SomasSemanais }>;
  /** Por rep, nos cenários de `naPrecisao`: Δ fill das 6 células (null = célula sem linha) e redução de estoque. */
  porRep: Record<string, { delta: Record<string, (number | null)[]>; reducao: number[] }>;
}

export function rodarLote(dados: Dados, cg: Congelado, reps: readonly number[], cacheDir?: string | null): Lote {
  const mapas = mapasDaAvaliacao(dados, cg, cacheDir);
  const janela: [string, string] = [JANELAS.avaliacaoIni, JANELAS.avaliacaoFim];
  const lote: Lote = { n: 0, somas: {}, porRep: {} };
  const cens = cenariosDaAvaliacao();
  for (const rep of reps) {
    for (const c of cens) {
      const m = mapas[c.pop];
      const base = { rep, lt: c.lt, falta: c.falta, inicial: c.inicial, janela, dados, substituicao: c.sub };
      const s0 = simular({ ...base, formula: 'F0', params: m.f0 });
      const s1 = simular({ ...base, formula: cg.candidata, params: m.alt });
      const k = chaveCenario(c);
      const atual = lote.somas[k];
      lote.somas[k] = { f0: somarSomas(atual?.f0 ?? null, s0), alt: somarSomas(atual?.alt ?? null, s1) };
      if (naPrecisao(c)) {
        const pr = (lote.porRep[k] ??= { delta: Object.fromEntries(CELULAS_SERVICO.map((x) => [x, []])), reducao: [] });
        for (const cel of CELULAS_SERVICO) {
          const a = fillDaCelula(s1, cel);
          const b = fillDaCelula(s0, cel);
          pr.delta[cel].push(a === null || b === null ? null : a - b);
        }
        const e0 = estoqueDaJanela(s0);
        pr.reducao.push(e0 > 0 ? 1 - estoqueDaJanela(s1) / e0 : NaN);
      }
    }
    lote.n++;
  }
  return lote;
}

function juntarLotes(a: Lote | null, b: Lote): Lote {
  if (a === null) return b;
  for (const [k, v] of Object.entries(b.somas)) {
    const x = a.somas[k];
    a.somas[k] = x ? { f0: somarSomas(x.f0, v.f0), alt: somarSomas(x.alt, v.alt) } : v;
  }
  for (const [k, v] of Object.entries(b.porRep)) {
    const x = a.porRep[k];
    if (!x) a.porRep[k] = v;
    else {
      for (const cel of Object.keys(v.delta)) x.delta[cel].push(...v.delta[cel]);
      x.reducao.push(...v.reducao);
    }
  }
  a.n += b.n;
  return a;
}

/** Lote em N processos filhos (cada um carrega os dados e lê as grades do cache em disco). */
async function rodarLoteParalelo(dados: Dados, dir: string, cg: Congelado, reps: number[], paralelo: number, cacheDir?: string | null): Promise<Lote> {
  if (paralelo <= 1) return rodarLote(dados, cg, reps, cacheDir);
  const tmp = join(dir, 'tmp-lotes');
  mkdirSync(tmp, { recursive: true });
  const partes: number[][] = Array.from({ length: paralelo }, () => []);
  reps.forEach((r, i) => partes[i % paralelo].push(r));
  const procs = partes
    .filter((p) => p.length > 0)
    .map((p, i) => {
      const out = join(tmp, `lote-${p[0]}-${i}.json`);
      const proc = Bun.spawn([process.execPath, import.meta.path, '--lote', '--dados', dir, '--congelado', JSON.stringify(cg), '--reps', p.join(','), '--out', out], {
        stdout: 'inherit',
        stderr: 'inherit',
      });
      return { proc, out };
    });
  let acc: Lote | null = null;
  for (const { proc, out } of procs) {
    const rc = await proc.exited;
    if (rc !== 0) throw new Error(`LOTE_FILHO_FALHOU: rc=${rc}`);
    acc = juntarLotes(acc, JSON.parse(readFileSync(out, 'utf8')) as Lote);
  }
  return acc!;
}

// ── evidência ─────────────────────────────────────────────────────────────────────────────────────────────────────
const BLOCOS: readonly BlocoBootstrap[] = [4, 8];
export interface IntervaloComNulos {
  porBloco: IntervaloPorBloco;
  /** Reamostragens com estatística null, por bloco. */
  nulos: Record<BlocoBootstrap, number>;
}

/** Bootstrap pareado nos dois blocos + contagem de reamostragens null (mesmos índices que o bootstrapPareado). */
export function bootstrap(b: SomasSemanais, a: SomasSemanais, estat: EstatisticaPareada): IntervaloComNulos {
  const porBloco = {} as IntervaloPorBloco;
  const nulos = {} as Record<BlocoBootstrap, number>;
  for (const bloco of BLOCOS) {
    porBloco[bloco] = bootstrapPareado([b], [a], estat, bloco, PRECISAO.bootstrapReamostragens);
    let n = 0;
    for (let r = 0; r < PRECISAO.bootstrapReamostragens; r++) if (estat([b], [a], indicesBlocosCirculares(b.semanas.length, bloco, r)) === null) n++;
    nulos[bloco] = n;
  }
  return { porBloco, nulos };
}
export function combinar(p: IntervaloPorBloco): Intervalo {
  const a = p[4];
  const b = p[8];
  return {
    ponto: a.ponto ?? b.ponto,
    li: a.li === null || b.li === null ? null : Math.min(a.li, b.li),
    ls: a.ls === null || b.ls === null ? null : Math.max(a.ls, b.ls),
  };
}

const somaV = (v: readonly number[]) => v.reduce((t, x) => t + x, 0);
/** Linhas OBSERVADAS da célula (a média das reps é a própria contagem: as linhas medidas são as mesmas em toda rep). */
const linhasObservadas = (m: SomasSemanais, c: Celula): number => Math.round(somaV(m.porCelula[c].demandadas));

interface Medias {
  f0: SomasSemanais;
  alt: SomasSemanais;
}
type PorCenario = Record<string, Medias>;
const pegar = (pc: PorCenario, c: Cenario): Medias => {
  const m = pc[chaveCenario(c)];
  if (!m) throw new Error(`CENARIO_SEM_RESULTADO:${chaveCenario(c)}`);
  return m;
};

export interface Nulos {
  cenario: string;
  item: string;
  nulos: Record<BlocoBootstrap, number>;
}

function servico(m: Medias, falta: Falta, nulos: Nulos[], rotulo: string): EvidenciaServico {
  const pisos = CLASSES.map((classe) => {
    const r = bootstrap(m.f0, m.alt, estatFillRate(classe));
    nulos.push({ cenario: rotulo, item: `fill ${classe}`, nulos: r.nulos });
    const linhas = linhasObservadas(m.alt, classe);
    const fill = fillDaCelula(m.alt, classe);
    return { classe, fill: r.porBloco, atendidas: fill === null ? null : fill * linhas, demandadas: linhas > 0 ? linhas : null };
  });
  const naoInferioridade = CELULAS_SERVICO.map((celula) => {
    const r = bootstrap(m.f0, m.alt, estatDeltaFillRate(celula));
    nulos.push({ cenario: rotulo, item: `Δ ${celula}`, nulos: r.nulos });
    return { celula, delta: r.porBloco };
  });
  return { falta, pisos, naoInferioridade };
}

function capital(m: Medias, falta: Falta, nulos: Nulos[], rotulo: string) {
  const r = bootstrap(m.f0, m.alt, estatReducaoCapital);
  nulos.push({ cenario: rotulo, item: 'redução de capital', nulos: r.nulos });
  return { falta, reducao: r.porBloco };
}

export function evidencia(
  pc: PorCenario,
  pop: Populacao,
  inicial: CenarioInicial,
  precisao: Evidencia['precisao'],
  nulos: Nulos[],
): { ev: Evidencia; sensibilidadeTaxa: { falta: Falta; grade: GradeCusto; custo: Intervalo }[] } {
  const cen = (lt: CenarioLT, falta: Falta): Cenario => ({ pop, inicial, lt, falta, sub: false });
  const rot = (lt: CenarioLT, falta: Falta) => `${pop}/${inicial}/${lt}/${falta}`;
  const ev: Evidencia = {
    servico: CENARIOS_FALTA.servico.map((f) => servico(pegar(pc, cen('empirico', f)), f, nulos, rot('empirico', f))),
    capital: FALTAS.map((f) => capital(pegar(pc, cen('empirico', f)), f, nulos, rot('empirico', f))),
    estresse: {
      servico: CENARIOS_FALTA.servico.map((f) => servico(pegar(pc, cen('estresse15', f)), f, nulos, rot('estresse15', f))),
      capital: FALTAS.map((f) => capital(pegar(pc, cen('estresse15', f)), f, nulos, rot('estresse15', f))),
    },
    economia: [],
    exposicao: CELULAS_SERVICO.map((celula) => ({ celula, linhas: linhasObservadas(pegar(pc, cen('empirico', 'espera')).alt, celula) })),
    precisao,
    estadosIniciais: null,
  };
  const sensibilidadeTaxa: { falta: Falta; grade: GradeCusto; custo: Intervalo }[] = [];
  for (const falta of CENARIOS_FALTA.economia) {
    const m = pegar(pc, cen('empirico', falta));
    const total = m.alt.porCelula.total;
    for (const taxa of GRADE_CUSTO.taxaAnual) {
      for (const emergencialPerc of GRADE_CUSTO.emergencial) {
        for (const atrasoPerc of GRADE_CUSTO.atrasoPorDia) {
          const grade: GradeCusto = { taxa, emergencialPerc, atrasoPerc };
          const r = bootstrap(m.f0, m.alt, estatCusto(grade));
          if (taxa !== GRADE_CUSTO.taxaBase) {
            sensibilidadeTaxa.push({ falta, grade, custo: combinar(r.porBloco) });
            continue;
          }
          nulos.push({ cenario: rot('empirico', falta), item: `custo ${emergencialPerc}/${atrasoPerc}`, nulos: r.nulos });
          const lim = custoLiquido(m.f0, m.alt, grade);
          ev.economia.push({
            falta, grade, custo: r.porBloco,
            linhasMargemLimitada: lim.linhasMargemLimitada, valorMargemLimitada: lim.valorMargemLimitada,
            // denominadores dos DOIS braços (o limite soma base + alt)
            linhasDemandadas: 2 * somaV(total.demandadas), valorDemandado: 2 * somaV(total.valorDem),
          });
        }
      }
    }
  }
  return { ev, sensibilidadeTaxa };
}

const semEstadoInicial = (cs: Criterio[]) => cs.filter((c) => c.criterio !== 'Estado inicial');

export interface OpcoesAvaliacao {
  paralelo: number;
  /** Tempos por etapa (preenchido). */
  tempos?: Record<string, number>;
  /** Teto de replicações (padrão PRECISAO.tetoReplicacoes). Só para teste de fumaça; a rodada real nunca reduz. */
  tetoReps?: number;
  /** Cache de grades (null = sem disco; padrão $REPLAY_DADOS/cache). */
  cacheDir?: string | null;
}

/** Passos 4–6 com a candidata CONGELADA: replicações até a precisão, evidência, tabela de decisão e tabelas do relatório. */
export async function avaliarCandidata(
  dados: Dados,
  dir: string,
  cg: Congelado,
  /** `vereditoDaCalibracao` (null = calibração sem ressalva; INCONCLUSIVO vira a linha INCERTO "Calibração"). */
  vereditoCalibracao: { veredito: VereditoReplay; motivos: string[] } | null,
  opcoes: OpcoesAvaliacao,
): Promise<{ veredito: { veredito: VereditoReplay; motivos: string[] }; avaliacao: NonNullable<Rodada['avaliacao']> }> {
  const { paralelo } = opcoes;
  const tempos = opcoes.tempos ?? {};
  const marca = (k: string, t0: number) => (tempos[k] = (performance.now() - t0) / 1000);
  const teto = opcoes.tetoReps ?? PRECISAO.tetoReplicacoes;
  const c = coorte(dados);
  let t: number;
  // 4–5. avaliação com replicações até a precisão
  t = performance.now();
  void mapasDaAvaliacao(dados, cg, opcoes.cacheDir); // pré-computa e grava as grades da avaliação no cache (os filhos só leem)
  marca('preComputarAvaliacao', t);
  t = performance.now();
  let lote: Lote | null = null;
  let reps = 0;
  let meiaServ: number | null = null;
  let meiaEst: number | null = null;
  const medirPrecisao = (l: Lote) => {
    let s = 0;
    let e = 0;
    for (const v of Object.values(l.porRep)) {
      for (const cel of CELULAS_SERVICO) {
        const xs = v.delta[cel].filter((x): x is number => x !== null);
        if (xs.length === v.delta[cel].length && xs.length > 1) s = Math.max(s, meiaLarguraMC(xs));
      }
      e = Math.max(e, meiaLarguraMC(v.reducao));
    }
    return { s, e };
  };
  while (reps < teto) {
    const passo = reps === 0 ? PRECISAO.replicacoesIniciais : PRECISAO.passoReplicacoes;
    const novas = Array.from({ length: Math.min(passo, teto - reps) }, (_, i) => reps + i);
    const tl = performance.now();
    lote = juntarLotes(lote, await rodarLoteParalelo(dados, dir, cg, novas, paralelo, opcoes.cacheDir));
    reps = lote.n;
    const p = medirPrecisao(lote);
    meiaServ = p.s;
    meiaEst = p.e;
    log(`reps ${reps}: meia largura serviço ${(meiaServ * 100).toFixed(3)} p.p., estoque ${(meiaEst * 100).toFixed(3)} p.p. (${((performance.now() - tl) / 1000).toFixed(1)} s)`);
    if (meiaServ <= PRECISAO.meiaLarguraServico && meiaEst <= PRECISAO.meiaLarguraEstoque) break;
  }
  marca('avaliacao', t);
  const L = lote!;
  if (L.n !== reps) throw new Error('REPS_INCOERENTES');

  // 6. evidência e veredito
  t = performance.now();
  const pc: PorCenario = {};
  for (const [k, v] of Object.entries(L.somas)) pc[k] = { f0: mediaSomas(v.f0, L.n), alt: mediaSomas(v.alt, L.n) };
  const precisao: Evidencia['precisao'] = {
    replicacoes: L.n, teto: teto, meiaLarguraServico: meiaServ, alvoServico: PRECISAO.meiaLarguraServico,
    meiaLarguraEstoque: meiaEst, alvoEstoque: PRECISAO.meiaLarguraEstoque,
  };
  const nulos: Nulos[] = [];
  const porEstado = INICIAIS.map((inicial) => {
    const { ev, sensibilidadeTaxa } = evidencia(pc, 'coorte', inicial, precisao, inicial === 'reconstruido' ? nulos : []);
    const crit = semEstadoInicial(avaliarCriterios(ev));
    return { inicial, ev, sensibilidadeTaxa, crit, v: veredito(crit) };
  });
  const rotuloEstado: Record<CenarioInicial, string> = { reconstruido: 'reconstruido+ajuste', piso_zero: 'piso_zero' };
  const principalEst = porEstado[0];
  const evFinal: Evidencia = { ...principalEst.ev, estadosIniciais: porEstado.map((e) => ({ rotulo: rotuloEstado[e.inicial], veredito: e.v.veredito })) };
  const todos = evidencia(pc, 'todos', 'reconstruido', precisao, []);
  const critTodos = semEstadoInicial(avaliarCriterios(todos.ev));
  const vTodos = veredito(critTodos);
  const extras: Criterio[] = [
    vereditoCalibracao === null
      ? { criterio: 'Calibração', estado: 'PASSA', motivo: 'três classes observáveis; candidata viável' }
      : { criterio: 'Calibração', estado: vereditoCalibracao.veredito === 'NO-GO' ? 'FALHA' : 'INCERTO', motivo: vereditoCalibracao.motivos.join('; ') },
    vTodos.veredito === principalEst.v.veredito
      ? { criterio: 'Coorte "todos os ativos"', estado: 'PASSA', motivo: `mesmo veredito (${vTodos.veredito})` }
      : { criterio: 'Coorte "todos os ativos"', estado: 'INCERTO', motivo: `veredito muda: coorte ${principalEst.v.veredito}, todos os ativos ${vTodos.veredito}` },
  ];
  const criterios = [...avaliarCriterios(evFinal), ...extras];
  const vf = veredito(criterios);
  marca('estatistica', t);

  // tabelas do relatório
  const intervalo = (m: Medias, estat: EstatisticaPareada) => bootstrap(m.f0, m.alt, estat).porBloco;
  const celulas: NonNullable<Rodada['avaliacao']>['celulas'] = [];
  const capitalT: NonNullable<Rodada['avaliacao']>['capital'] = [];
  const terminal: NonNullable<Rodada['avaliacao']>['terminal'] = [];
  for (const cen of cenariosDaAvaliacao()) {
    const m = pegar(pc, cen);
    for (const celula of CELULAS) {
      const linhas = linhasObservadas(m.alt, celula);
      if (linhas === 0) {
        celulas.push({ cenario: cen, celula, linhas, f0: null, alt: null, delta: null });
        continue;
      }
      celulas.push({
        cenario: cen, celula, linhas,
        f0: combinar(bootstrap(m.f0, m.f0, estatFillRate(celula)).porBloco),
        alt: combinar(intervalo(m, estatFillRate(celula))),
        delta: intervalo(m, estatDeltaFillRate(celula)),
      });
    }
    capitalT.push({ cenario: cen, estoqueF0: estoqueDaJanela(m.f0), estoqueAlt: estoqueDaJanela(m.alt), reducao: intervalo(m, estatReducaoCapital) });
    terminal.push({ cenario: cen, f0: { terminal: m.f0.terminal, balanco: m.f0.balanco }, alt: { terminal: m.alt.terminal, balanco: m.alt.balanco } });
  }
  const mBase = pegar(pc, { pop: 'coorte', inicial: 'reconstruido', lt: 'empirico', falta: 'espera', sub: false });
  const equilibrio = FALTAS.map((falta) => {
    const m = pegar(pc, { pop: 'coorte', inicial: 'reconstruido', lt: 'empirico', falta, sub: false });
    return { falta, valor: custoFaltaEquilibrio(m.f0, m.alt, GRADE_CUSTO.taxaBase) };
  });
  // DIO Sayerlack: CMV diário = Σ cmcLinha × quantidade das linhas da coorte na avaliação ÷ dias corridos da janela
  const diasJanela = somaV(mBase.f0.diasCorridos);
  let cmv = 0;
  let semCmc = 0;
  for (const v of dados.vendas) {
    if (!v.noEscopo || !c.populacao.has(v.sku) || v.data < JANELAS.avaliacaoIni || v.data > JANELAS.avaliacaoFim || !(v.quantidade > 0)) continue;
    if (v.cmcLinha === null) semCmc++;
    else cmv += v.cmcLinha * v.quantidade;
  }
  const cmvDia = cmv > 0 ? cmv / diasJanela : null;
  // Fn aplicada também aos suaves (informativo, spec §5.3): 50 reps, empírico, espera, reconstruído
  const fnTodos = preAval(cg.candidata, dados, cg.params, opcoes.cacheDir);
  const f0Todos = preAval('F0', dados, QUANTIL_NEUTRO, opcoes.cacheDir);
  const suaves = new Set([...c.populacao].filter((s) => !c.alterados.has(s)));
  const puro = mapaMisto(f0Todos, fnTodos, c.populacao, c.populacao);
  const misto = mapaMisto(f0Todos, null, c.populacao, c.alterados);
  let accP: SomasSemanais | null = null;
  let accB: SomasSemanais | null = null;
  for (let rep = 0; rep < REPS_CALIBRACAO; rep++) {
    const b = { rep, lt: 'empirico' as const, falta: 'espera' as const, inicial: 'reconstruido' as const, janela: [JANELAS.avaliacaoIni, JANELAS.avaliacaoFim] as [string, string], dados };
    accP = somarSomas(accP, simular({ ...b, formula: cg.candidata, params: puro }));
    accB = somarSomas(accB, simular({ ...b, formula: 'F0', params: misto }));
  }
  const fillSuaves = (s: SomasSemanais) => {
    const tot = s.porCelula.total;
    const alt = (['A_alt', 'B_alt', 'C_alt'] as const).map((x) => s.porCelula[x]);
    const dem = somaV(tot.demandadas) - alt.reduce((t2, x) => t2 + somaV(x.demandadas), 0);
    const ok = somaV(tot.integrais) - alt.reduce((t2, x) => t2 + somaV(x.integrais), 0);
    return { linhas: Math.round(dem / REPS_CALIBRACAO), fill: dem > 0 ? ok / dem : null };
  };

  return {
    veredito: vf,
    avaliacao: {
      reps: L.n,
      meiaLarguraServico: meiaServ,
      meiaLarguraEstoque: meiaEst,
      criterios,
      vereditoPorEstado: porEstado.map((e) => ({ rotulo: rotuloEstado[e.inicial], veredito: e.v.veredito, motivos: e.v.motivos })),
      todosAtivos: { veredito: vTodos.veredito, motivos: vTodos.motivos },
      sensibilidadeTaxa: principalEst.sensibilidadeTaxa,
      blocos: principalEst.ev,
      celulas,
      capital: capitalT,
      terminal,
      equilibrio,
      dio: cmvDia === null ? null : { f0: estoqueDaJanela(mBase.f0) / cmvDia, alt: estoqueDaJanela(mBase.alt) / cmvDia, linhasSemCmc: semCmc },
      suaves: { n: suaves.size, f0: fillSuaves(accB!), fnPura: fillSuaves(accP!) },
      nulos,
      skusSemCmc: mBase.f0.skusSemCmc,
      excluidosSimulacao: mBase.f0.excluidos,
      linhasIgnoradas: mBase.f0.linhasIgnoradas,
    },
  };
}

// ── gate de paridade do F0 (R19/R21; plano T5 Step 5: F0 infiel invalida o denominador → PARAR) ─────────────────
export interface GateParidade {
  es: number | null;
  pp: number | null;
  max: number | null;
  /** Σ|Δmáximo|·cmc ÷ Σ máximo·cmc nas divergências da primária. */
  valor: number | null;
  /** Quantidade com PP/máximo gravados (R21: deve bater em todos). */
  decisao: { n: number; de: number };
  /** Quantidade com o estado do replay (informativo, R21). */
  estado: { n: number; de: number };
}
/** ES/PP/máximo ≥ 95%, valor divergente ≤ 2% e decisão n = de (> 0). Ausente (null) = FALHA. */
export function gateParidadePassa(g: GateParidade): boolean {
  return [g.es, g.pp, g.max].every((x) => x !== null && x >= 0.95) && g.valor !== null && g.valor <= 0.02 && g.decisao.de > 0 && g.decisao.n === g.decisao.de;
}
/** Gate em FALHA ⇒ ErroDadosReplay (rc ≠ 0): nenhum veredito, muito menos GO, com o F0 infiel. */
export function exigirGateParidade(g: GateParidade): void {
  if (!gateParidadePassa(g)) throw new ErroDadosReplay(`GATE_PARIDADE_FALHA: ${JSON.stringify(g)}`);
}
/** Argumento de linha de comando inválido (rc 2; ≠ erro de dado). */
export class ErroArgumento extends Error {}

// ── principal ─────────────────────────────────────────────────────────────────────────────────────────────────────
function args(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const prox = argv[i + 1];
    if (prox !== undefined && !prox.startsWith('--')) {
      out[a.slice(2)] = prox;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function principal(): Promise<number> {
  const a = args(process.argv.slice(2));
  const dir = typeof a.dados === 'string' ? a.dados : (process.env.REPLAY_DADOS ?? join(homedir(), '.cache/afiacao/reposicao-replay'));
  if (a.lote === true) {
    const cg = JSON.parse(String(a.congelado)) as Congelado;
    const reps = String(a.reps).split(',').map(Number);
    const lote = rodarLote(carregarDados(dir), cg, reps);
    writeFileSync(String(a.out), JSON.stringify(lote));
    return 0;
  }
  const saida = typeof a.saida === 'string' ? a.saida : join(dir, 'relatorio.md');
  const paralelo = a.paralelo === undefined ? 4 : Number(a.paralelo);
  if (!(Number.isInteger(paralelo) && paralelo >= 1 && paralelo <= 64)) throw new ErroArgumento(`--paralelo deve ser inteiro entre 1 e 64 (veio ${String(a.paralelo)})`);
  const t0 = performance.now();
  const tempos: Record<string, number> = {};
  const marca = (k: string, t: number) => (tempos[k] = (performance.now() - t) / 1000);

  // 1. dados e coorte
  let t = performance.now();
  const dados = carregarDados(dir);
  const c = coorte(dados);
  const ct = coorteTodosAtivos(dados);
  log(`dados: ${dados.vendas.length} linhas, coorte ${c.populacao.size} (alterados ${c.alterados.size}), todos os ativos ${ct.populacao.size}`);
  marca('carga', t);

  // paridade do F0 (gate R19/R21)
  t = performance.now();
  const parF0 = paridadeF0(dados);
  const parQtd = paridadeQuantidade(dados, (sku) => parametrosNoDia('F0', dados, sku, dados.dataExtracao, QUANTIL_NEUTRO, { calibracao: false }));
  const pct = (n: number, de: number) => (de > 0 ? n / de : null);
  const pr = parF0.primaria;
  const gate: GateParidade = {
    es: pct(pr.dentro.es, pr.comparados.es),
    pp: pct(pr.dentro.pp, pr.comparados.pp),
    max: pct(pr.dentro.max, pr.comparados.max),
    valor: pr.valorMaximoTotal > 0 ? pr.valorDeltaMaximoDivergente / pr.valorMaximoTotal : null,
    decisao: parQtd.gravado,
    estado: parQtd.replay,
  };
  const gatePassa = gateParidadePassa(gate);
  log(`GATE_PARIDADE ${gatePassa ? 'PASSA' : 'FALHA'}: ES ${gate.es} PP ${gate.pp} máx ${gate.max} valor ${gate.valor} decisão ${gate.decisao.n}/${gate.decisao.de} estado ${gate.estado.n}/${gate.estado.de}`);
  exigirGateParidade(gate); // FALHA ⇒ ErroDadosReplay ⇒ rc ≠ 0, antes da calibração (review I-3)
  marca('paridade', t);

  // 2. calibração
  t = performance.now();
  const base = baseDaCalibracao(dados);
  log(`alvo: ${JSON.stringify(base.alvo)} fill F0 calib ${JSON.stringify(base.fillF0)}`);
  const resultados: ResultadoCalibracao[] = [];
  for (const f of ['F1', 'F2', 'F3'] as const) {
    const tf = performance.now();
    const r = calibrar(dados, f);
    resultados.push(r);
    log(`calibrar ${f}: ${JSON.stringify(r.params)} inviável=${r.inviavel} redução=${(1 - r.estoqueMedio / r.estoqueF0).toFixed(4)} (${((performance.now() - tf) / 1000).toFixed(1)} s)`);
  }
  const candidata = escolherCandidata(resultados);
  marca('calibracao', t);
  log(`candidata: ${candidata}`);

  // fronteira (informativa, janela de calibração): quantil uniforme nas 3 classes, β/janela calibrados
  t = performance.now();
  const fronteira: Rodada['fronteira'] = [];
  const c0 = coorte(dados);
  for (const r of resultados.filter((x) => x.formula === 'F2' || x.formula === 'F3')) {
    for (const q of GRADE_QUANTIS.filter((x) => x >= 0.9)) {
      const p: ParamsFormula = { ...r.params, quantil: { A: q, B: q, C: q } };
      const mapa = mapaMisto(base.f0Mapa, preComputar(r.formula, dados, p, { calibracao: true }), c0.populacao, c0.alterados);
      const av = avaliarNaCalibracao(dados, r.formula, mapa, REPS_CALIBRACAO);
      fronteira.push({ formula: r.formula, params: p, fill: { ...av.fill, total: fillDaCelula(av.somas, 'total') }, reducao: 1 - av.estoque / base.estoqueF0 });
    }
  }
  marca('fronteira', t);

  const comum = {
    geradoEm: new Date().toISOString(),
    nomeMetrica: NOME_METRICA_SERVICO,
    chave: {
      hashDados: dados.hashDados, hashCodigo: hashCodigo(), dataExtracao: dados.dataExtracao,
      calendario: 'seg–sex sem feriados; atendimento = du ∪ dias com venda', janelas: JANELAS,
      precisao: { trajetoriasF2: TSB.trajetorias, bootstrap: PRECISAO.bootstrapReamostragens, repsCalibracao: REPS_CALIBRACAO, ...PRECISAO },
    },
    coorte: { populacao: c.populacao.size, alterados: c.alterados.size, todos: ct.populacao.size, excluidosInsumo: c.excluidos },
    paridade: { f0: parF0, quantidade: parQtd, gate, gatePassa },
    calibracao: { alvo: base.alvo, fillF0: base.fillF0, resultados, candidata },
    fronteira,
    excluidosDados: dados.excluidos,
    avisos: dados.avisos,
    parados: c.parados,
    negativos: negativosNaAvaliacao(dados),
    estadoInicial: diagnosticoEstadoInicial(dados),
  };

  const vc = vereditoDaCalibracao(resultados);
  if (candidata === 'NENHUMA' || vc?.veredito === 'NO-GO') {
    const v = vc ?? { veredito: 'NO-GO' as const, motivos: ['INVIAVEL_NA_CALIBRACAO'] };
    const rodada: Rodada = { ...comum, congelado: null, veredito: v, avaliacao: null, tempos, segundos: (performance.now() - t0) / 1000 };
    escreverRelatorio(rodada, saida);
    log(`VEREDITO ${v.veredito} (${v.motivos.join('; ')}) → ${saida}`);
    return 0;
  }
  const rc = resultados.find((x) => x.formula === candidata)!;
  const cg: Congelado = Object.freeze({ candidata, params: structuredClone(rc.params) });

  const av = await avaliarCandidata(dados, dir, cg, vc, { paralelo, tempos });
  const vf = av.veredito;
  const L = { n: av.avaliacao.reps };
  const rodada: Rodada = { ...comum, congelado: cg, veredito: vf, avaliacao: av.avaliacao, tempos, segundos: (performance.now() - t0) / 1000 };
  escreverRelatorio(rodada, saida);
  writeFileSync(join(dirname(saida), 'rodada.json'), JSON.stringify(rodada, (_k, v: unknown) => (v instanceof Set ? [...v] : v instanceof Map ? [...v] : v)));
  log(`VEREDITO ${vf.veredito} (${L.n} reps, ${((performance.now() - t0) / 1000).toFixed(1)} s) → ${saida}`);
  for (const m of vf.motivos.slice(0, 40)) log(`  motivo: ${m}`);
  return 0;
}

export type { Classe, VereditoReplay };

if (import.meta.main) {
  principal().then(
    (rc) => process.exit(rc),
    (e: unknown) => {
      console.error(e instanceof ErroDadosReplay ? `ERRO DE DADOS: ${e.message}` : e instanceof ErroArgumento ? `ERRO DE ARGUMENTO: ${e.message}` : e);
      process.exit(e instanceof ErroArgumento ? 2 : 1);
    },
  );
}
