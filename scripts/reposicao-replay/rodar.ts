// Orquestração do replay TSB (plano, Task 9): `bun scripts/reposicao-replay/rodar.ts [--dados DIR] [--saida ARQ] [--paralelo N]
// [--informativo-saldo-hoje]`. Antes da calibração: âncora Omie (R30), validação de classe (achado 14) e gate de paridade (achado 8).
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
import { mensagemDeErro } from '../../src/lib/erro-mensagem';
import { diffDias } from '../../src/lib/reposicao/orcamento-compra/datas';
import { duAte, type CenarioLT } from './aleatorio';
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
  populacaoDoModo,
  REPS_CALIBRACAO,
  somarSomas,
  type CelulasAlvo,
  type ResultadoCalibracao,
} from './calibracao';
import { classeEfetiva, validarClasse, type ValidacaoClasse } from './classe';
import { CENARIOS_FALTA, GRADE_CUSTO, GRADE_QUANTIS, INICIO_AQUECIMENTO, JANELAS, NOME_METRICA_SERVICO, PRECISAO, TSB } from './config';
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
import { diagnosticoF0, grupoDeEmbalagem, hashCodigo, parametrosNoDia, paridadeF0, preComputar, preComputarComOrigem, type Formula, type ParamsDia, type ParamsFormula } from './formulas';
import { custoFaltaEquilibrio, custoLiquido, fracaoGrupos, fracaoNaoValorada, type GradeCusto } from './metricas';
import { coorte, coorteTodosAtivos } from './parados';
import { diagnosticoEstadoInicial, negativosNaAvaliacao, reconstruirSkus, type CenarioInicial } from './reconstrucao';
import { escreverRelatorio, type Diagnostico, type Rodada } from './relatorio';
import { CELULAS, paridadeQuantidade, simular, type Celula, type Falta, type SomasSemanais } from './simulador';
import {
  ErroDadosReplay,
  type BlocoBootstrap,
  type Classe,
  type Dados,
  type Data,
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
  /** Ausente/'classe' = rodada OFICIAL; 'alt' = rodada INFORMATIVA NÃO OFICIAL (R27): só a população alterada é simulada. */
  celulasAlvo?: CelulasAlvo;
}
/** Por população: os mapas e o conjunto `alterados` que troca a fórmula — o MESMO que define as células *_alt (revisão final I2). */
interface Mapas {
  coorte: { f0: Map<string, ParamsDia>; alt: Map<string, ParamsDia>; alterados: Set<string> };
  todos: { f0: Map<string, ParamsDia>; alt: Map<string, ParamsDia>; alterados: Set<string> };
}
/** Parâmetros do F0 no baseline simulado (o quantil não entra no F0); os MESMOS no gate de paridade (achado 8). */
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
  const modo = cg.celulasAlvo ?? 'classe';
  const pc = populacaoDoModo(c, modo);
  const pt = populacaoDoModo(t, modo);
  return {
    coorte: { f0: mapaMisto(f0, null, pc, c.alterados), alt: mapaMisto(f0, fn, pc, c.alterados), alterados: c.alterados },
    todos: { f0: mapaMisto(f0, null, pt, t.alterados), alt: mapaMisto(f0, fn, pt, t.alterados), alterados: t.alterados },
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
      const base = { rep, lt: c.lt, falta: c.falta, inicial: c.inicial, janela, dados, substituicao: c.sub, alterados: m.alterados };
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
  return { falta, reducao: r.porBloco, naoValorado: { f0: fracaoNaoValorada(m.f0), alt: fracaoNaoValorada(m.alt) } };
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
            linhasMargemDesconhecida: lim.linhasMargemDesconhecida, valorMargemDesconhecida: lim.valorMargemDesconhecida,
            // denominadores dos DOIS braços (a margem desconhecida soma base + alt)
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
    // M-3: com menos que as replicações iniciais da spec (teto reduzido, só teste), a meia largura não é estimável: null ⇒ INCERTO
    replicacoes: L.n, teto: teto, meiaLarguraServico: L.n >= PRECISAO.replicacoesIniciais ? meiaServ : null, alvoServico: PRECISAO.meiaLarguraServico,
    meiaLarguraEstoque: L.n >= PRECISAO.replicacoesIniciais ? meiaEst : null, alvoEstoque: PRECISAO.meiaLarguraEstoque,
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
    capitalT.push({
      cenario: cen, estoqueF0: estoqueDaJanela(m.f0), estoqueAlt: estoqueDaJanela(m.alt), reducao: intervalo(m, estatReducaoCapital),
      naoValorado: { f0: fracaoNaoValorada(m.f0), alt: fracaoNaoValorada(m.alt) },
      grupos: { f0: fracaoGrupos(m.f0), alt: fracaoGrupos(m.alt) },
    });
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
    if (!v.noEscopo || !populacaoDoModo(c, cg.celulasAlvo ?? 'classe').has(v.sku) || v.data < JANELAS.avaliacaoIni || v.data > JANELAS.avaliacaoFim || !(v.quantidade > 0)) continue;
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

// ── calibração por modo, fronteira, diagnóstico e rodada informativa (R27) ──────────────────────────────────────────
interface Calibracao {
  base: ReturnType<typeof baseDaCalibracao>;
  resultados: ResultadoCalibracao[];
  candidata: Formula | 'NENHUMA';
  vc: ReturnType<typeof vereditoDaCalibracao>;
  fronteira: Rodada['fronteira'];
}

/** Calibra F1–F3 no modo, escolhe a candidata e mede a fronteira (informativa: quantil uniforme, janela de calibração). */
function calibrarNoModo(dados: Dados, modo: CelulasAlvo): Calibracao {
  const rot = modo === 'alt' ? '[informativo R27] ' : '';
  const base = baseDaCalibracao(dados, { celulasAlvo: modo });
  log(`${rot}alvo: ${JSON.stringify(base.alvo)} fill F0 calib ${JSON.stringify(base.fillF0)}`);
  const resultados: ResultadoCalibracao[] = [];
  for (const f of ['F1', 'F2', 'F3'] as const) {
    const tf = performance.now();
    const r = calibrar(dados, f, { celulasAlvo: modo });
    resultados.push(r);
    log(`${rot}calibrar ${f}: ${JSON.stringify(r.params)} inviável=${r.inviavel} redução=${(1 - r.estoqueMedio / r.estoqueF0).toFixed(4)} (${((performance.now() - tf) / 1000).toFixed(1)} s)`);
  }
  const candidata = escolherCandidata(resultados);
  log(`${rot}candidata: ${candidata}`);
  const c0 = coorte(dados);
  const fronteira: Rodada['fronteira'] = [];
  for (const r of resultados.filter((x) => x.formula === 'F2' || x.formula === 'F3')) {
    for (const q of GRADE_QUANTIS.filter((x) => x >= 0.9)) {
      const p: ParamsFormula = { ...r.params, quantil: { A: q, B: q, C: q } };
      const mapa = mapaMisto(base.f0Mapa, preComputar(r.formula, dados, p, { calibracao: true }), populacaoDoModo(c0, modo), c0.alterados);
      const av = avaliarNaCalibracao(dados, r.formula, mapa, REPS_CALIBRACAO, modo);
      fronteira.push({ formula: r.formula, params: p, fill: { ...av.fill, total: fillDaCelula(av.somas, 'total') }, reducao: 1 - av.estoque / base.estoqueF0 });
    }
  }
  return { base, resultados, candidata, vc: vereditoDaCalibracao(resultados), fronteira };
}

/** R27: rodada INFORMATIVA NÃO OFICIAL — alvo e tabela §6.1 nas células *_alt (população simulada = só os alterados). */
async function rodadaInformativa(dados: Dados, dir: string, paralelo: number, tempos: Record<string, number>): Promise<NonNullable<Rodada['informativo']>> {
  let t = performance.now();
  const cal = calibrarNoModo(dados, 'alt');
  tempos.calibracao = (performance.now() - t) / 1000;
  const calibracao = { alvo: cal.base.alvo, fillF0: cal.base.fillF0, resultados: cal.resultados, candidata: cal.candidata };
  if (cal.candidata === 'NENHUMA' || cal.vc?.veredito === 'NO-GO') {
    return { veredito: cal.vc ?? { veredito: 'NO-GO', motivos: ['INVIAVEL_NA_CALIBRACAO'] }, congelado: null, calibracao, fronteira: cal.fronteira, avaliacao: null };
  }
  const r = cal.resultados.find((x) => x.formula === cal.candidata)!;
  const cg: Congelado = Object.freeze({ candidata: cal.candidata, params: structuredClone(r.params), celulasAlvo: 'alt' as const });
  t = performance.now();
  const av = await avaliarCandidata(dados, dir, cg, cal.vc, { paralelo, tempos });
  tempos.total = (performance.now() - t) / 1000;
  log(`[informativo R27] VEREDITO ${av.veredito.veredito} (${av.avaliacao.reps} reps)`);
  return { veredito: av.veredito, congelado: cg, calibracao, fronteira: cal.fronteira, avaliacao: av.avaliacao };
}

/** Diagnóstico de plausibilidade da calibração oficial (R27): A-suaves × A-alterados, semanas, demanda, LT e operação real. */
function diagnosticar(dados: Dados, base: ReturnType<typeof baseDaCalibracao>): Diagnostico {
  const c = coorte(dados);
  const m = base.somasF0;
  const sm = (x: readonly number[]) => x.reduce((a, b) => a + b, 0);
  const demA = sm(m.porCelula.A.demandadas);
  const intA = sm(m.porCelula.A.integrais);
  const demAlt = sm(m.porCelula.A_alt.demandadas);
  const intAlt = sm(m.porCelula.A_alt.integrais);
  const fr = (n: number, d: number) => (d > 0 ? n / d : null);
  const semanalA = m.semanas.map((semana, w) => ({ semana, fill: fr(m.porCelula.A.integrais[w], m.porCelula.A.demandadas[w]) }));
  // SKUs de A (classe efetiva no início da calibração, R2) e a demanda por mês
  const classe = classeEfetiva(dados, JANELAS.calibracaoIni);
  const skusA = new Set([...c.populacao].filter((s) => (classe.get(s) ?? 'C') === 'A'));
  const porMes = new Map<string, number>();
  for (const v of dados.vendas) {
    if (!v.noEscopo || !skusA.has(v.sku) || v.data < JANELAS.calibracaoIni || v.data > JANELAS.calibracaoFim || !(v.quantidade > 0)) continue;
    porMes.set(v.data.slice(0, 7), (porMes.get(v.data.slice(0, 7)) ?? 0) + v.quantidade);
  }
  // LT realizado × LT do parâmetro nos pedidos de A do F0 (rep 0) na 2ª metade da calibração
  const desde = '2026-03-16';
  const s0 = simular({ formula: 'F0', params: base.f0Mapa, rep: 0, lt: 'empirico', falta: 'espera', inicial: 'reconstruido', janela: [JANELAS.calibracaoIni, JANELAS.calibracaoFim], dados, rastro: true });
  let nLt = 0;
  let somaSort = 0;
  let somaPar = 0;
  let nPar = 0;
  for (const p of s0.pedidos ?? []) {
    if (!skusA.has(p.sku) || p.dia < desde || p.chegada === null) continue;
    nLt++;
    somaSort += duAte(p.chegada) - duAte(p.dia);
    const lt = diagnosticoF0(dados, p.sku, p.dia, { calibracao: true }).lt;
    if (lt !== null) {
      somaPar += lt;
      nPar++;
    }
  }
  // operação real: estoque reconstruído (com ajuste) valorado como na calibração e recebido até 30/04
  const rec = reconstruirSkus(dados);
  const cmc = new Map<string, { d: Data; c: number }>();
  for (const v of dados.vendas) {
    if (v.cmcLinha === null || !(v.cmcLinha > 0) || v.data > JANELAS.calibracaoFim || !c.populacao.has(v.sku)) continue;
    const x = cmc.get(v.sku);
    if (!x || v.data > x.d) cmc.set(v.sku, { d: v.data, c: v.cmcLinha });
  }
  let soma = 0;
  let dias = 0;
  for (let i = diffDias(INICIO_AQUECIMENTO, JANELAS.calibracaoIni); i <= diffDias(INICIO_AQUECIMENTO, JANELAS.calibracaoFim); i++) {
    for (const s of c.populacao) {
      const it = rec.itens.get(s);
      const cc = cmc.get(s);
      if (it && cc) soma += (it.fimDia[i] + it.ajuste) * cc.c;
    }
    dias++;
  }
  let recebidoReal = 0;
  for (const r of dados.recebimentos) if (c.populacao.has(r.sku) && r.data <= JANELAS.calibracaoFim) recebidoReal += r.quantidade;
  return {
    fillF0A: { total: fr(intA, demA), alterados: fr(intAlt, demAlt), suaves: fr(intA - intAlt, demA - demAlt), linhasAlterados: Math.round(demAlt), linhasSuaves: Math.round(demA - demAlt) },
    semanalA,
    demandaA: [...porMes].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([mes, unidades]) => ({ mes, unidades })),
    lt: { desde, pedidos: nLt, sorteadoMedio: nLt > 0 ? somaSort / nLt : null, parametroMedio: nPar > 0 ? somaPar / nPar : null },
    real: { estoqueReal: soma / dias, estoqueF0: base.estoqueF0, recebidoReal, recebidoF0: m.balanco.recebido },
  };
}

/**
 * M-1: grava o relatório OFICIAL antes de tudo e só depois tenta a rodada informativa (R27). Uma exceção nela é
 * registrada em `informativoErro` e regravada; nunca impede nem altera o veredito oficial.
 */
export async function anexarInformativa(
  oficial: Rodada,
  executar: () => Promise<NonNullable<Rodada['informativo']>>,
  gravar: (r: Rodada) => void,
): Promise<Rodada> {
  gravar(oficial);
  try {
    const informativo = await executar();
    const r = { ...oficial, informativo, informativoErro: null };
    gravar(r);
    return r;
  } catch (e) {
    const r = { ...oficial, informativo: null, informativoErro: `${nomeDoErro(e)}: ${mensagemDeErro(e) ?? 'erro sem mensagem'}` };
    gravar(r);
    return r;
  }
}

/** Nome do erro para o registro (sem `String(err)`: o gate "[object Object]" do repo barra o idiom). */
function nomeDoErro(e: unknown): string {
  const n = e !== null && typeof e === 'object' ? (e as { name?: unknown }).name : undefined;
  return typeof n === 'string' && n.length > 0 ? n : 'Erro';
}

// ── gate de paridade do F0 (R19/R21 + achado 8; plano T5 Step 5: F0 infiel invalida o denominador → PARAR) ─────────
/**
 * Achado 8: divergência de ESTADO (decisão com os parâmetros do replay ≠ produção) só passa nesta allowlist NOMEADA e
 * justificada — nunca por limiar. Hoje: a edição humana provada na R21.
 */
export const ESTADO_DIVERGENTE_PERMITIDO: Readonly<Record<string, string>> = Object.freeze({
  '8689783095': 'R21: edição humana fora da fórmula — edicao_manual 2026-05-15 e aprovacao_humana 2026-05-22/05-27 em sku_parametros_historico',
});
/** Mínimo de concordância de ES/PP/máximo (R19), do status OK e da presença na view (achado 8). */
export const PARIDADE_MINIMA = 0.95;

export interface GateParidade {
  es: number | null;
  pp: number | null;
  max: number | null;
  /** Σ|Δmáximo|·cmc ÷ Σ máximo·cmc nas divergências da primária. */
  valor: number | null;
  /** Quantidade com PP/máximo gravados (R21: deve bater em todos). */
  decisao: { n: number; de: number };
  /** Achado 8: quantidade com o ESTADO do replay (os parâmetros que o baseline usa); divergentes só na allowlist. */
  estado: { n: number; de: number; divergentes: string[] };
  /** Concordância do status OK replay × view (primária). null = não medida ⇒ FALHA. */
  status: { n: number; de: number } | null;
  /** Cobertura: presença na view replay × produção; e linhas de sugestao_hoje comparáveis (sem FORA_DOS_DADOS). */
  cobertura: { view: { n: number; de: number }; decisao: { n: number; de: number } };
  /** Os parâmetros do gate = os do mapa F0 que o baseline simulado usou (último dia útil da avaliação), por SKU. */
  paramsBaseline: { n: number; de: number };
}

const fracao = (x: { n: number; de: number } | null): number | null => (x !== null && x.de > 0 ? x.n / x.de : null);

/** Falhas do gate, cada uma com a MARCA do ramo no início. Lista vazia = passa. Ausente (null, de = 0) = FALHA. */
export function falhasDoGate(g: GateParidade): string[] {
  const f: string[] = [];
  for (const k of ['es', 'pp', 'max'] as const) {
    const x = g[k];
    if (x === null || !(x >= PARIDADE_MINIMA)) f.push(`PARIDADE_${k.toUpperCase()}: ${x}`);
  }
  if (g.valor === null || !(g.valor <= 0.02)) f.push(`VALOR_DIVERGENTE: ${g.valor}`);
  if (!(g.decisao.de > 0 && g.decisao.n === g.decisao.de)) f.push(`DECISAO: ${g.decisao.n}/${g.decisao.de}`);
  const e = g.estado;
  if (!(e.de > 0) || e.de - e.n !== e.divergentes.length) f.push(`ESTADO_INCOERENTE: ${e.n}/${e.de} com ${e.divergentes.length} divergente(s) listado(s)`);
  const fora = e.divergentes.filter((sku) => !(sku in ESTADO_DIVERGENTE_PERMITIDO));
  if (fora.length > 0) f.push(`ESTADO_DIVERGENTE_FORA_DA_ALLOWLIST: ${fora.join(', ')}`);
  const st = fracao(g.status);
  if (st === null || !(st >= PARIDADE_MINIMA)) f.push(`STATUS: ${g.status ? `${g.status.n}/${g.status.de}` : 'não medido'}`);
  const cv = fracao(g.cobertura.view);
  if (cv === null || !(cv >= PARIDADE_MINIMA)) f.push(`COBERTURA_VIEW: ${g.cobertura.view.n}/${g.cobertura.view.de}`);
  const cd = g.cobertura.decisao;
  if (!(cd.de > 0 && cd.n === cd.de)) f.push(`COBERTURA_DECISAO: ${cd.n}/${cd.de}`);
  const pb = g.paramsBaseline;
  if (!(pb.de > 0 && pb.n === pb.de)) f.push(`PARAMS_BASELINE: ${pb.n}/${pb.de}`);
  return f;
}
/** R19/R21 + achado 8: ES/PP/máximo ≥ 95%, valor ≤ 2%, decisão e estado (allowlist), status, cobertura e parâmetros do baseline. */
export function gateParidadePassa(g: GateParidade): boolean {
  return falhasDoGate(g).length === 0;
}
/** Gate em FALHA ⇒ ErroDadosReplay (rc ≠ 0): nenhum veredito, muito menos GO, com o F0 infiel. */
export function exigirGateParidade(g: GateParidade): void {
  const f = falhasDoGate(g);
  if (f.length > 0) throw new ErroDadosReplay(`GATE_PARIDADE_FALHA: ${f.join('; ')}`);
}

/**
 * Achado 8: confere, SKU a SKU, que `parametrosNoDia` (a função que o gate usa no dia da extração) dá, no último dia útil
 * da avaliação, EXATAMENTE o que está no mapa F0 que o baseline simulou. SKU ausente do mapa conta como divergente.
 */
export function conferirParamsDoBaseline(dados: Dados, mapa: ReadonlyMap<string, ParamsDia>, skus: Iterable<string>, p: ParamsFormula): { n: number; de: number } {
  let ultimo: Data | null = null;
  for (const k of mapa.keys()) {
    const d = k.slice(k.indexOf('|') + 1);
    if (d <= JANELAS.avaliacaoFim && (ultimo === null || d > ultimo)) ultimo = d;
  }
  const out = { n: 0, de: 0 };
  for (const sku of skus) {
    out.de++;
    if (ultimo === null) continue;
    const m = mapa.get(`${sku}|${ultimo}`);
    if (m !== undefined && JSON.stringify(m) === JSON.stringify(parametrosNoDia('F0', dados, sku, ultimo, p, { calibracao: false }))) out.n++;
  }
  return out;
}

// ── gate de classe (achado 14, §5.1.1) e âncora (R30) ───────────────────────────────────────────────────────────────
/** §5.1.1: divergência da classe recalculada × a de hoje acima de 5% do valor A (ou não mensurável) interrompe o trabalho. */
export const CLASSE_DIVERGENCIA_MAXIMA_PCT = 5;
export function exigirValidacaoClasse(v: ValidacaoClasse): void {
  if (v.valorADivergente === null || !(v.valorADivergente <= CLASSE_DIVERGENCIA_MAXIMA_PCT)) {
    throw new ErroDadosReplay(`CLASSE_DIVERGENTE: ${v.valorADivergente === null ? 'sem valor A hoje (não mensurável)' : `${v.valorADivergente.toFixed(2)}%`} do valor A diverge (máximo ${CLASSE_DIVERGENCIA_MAXIMA_PCT}%); ${JSON.stringify(v.detalhe)}`);
  }
}

/**
 * R30: a rodada OFICIAL exige a âncora do Omie (posicao_omie_<abertura>.csv). Sem ela, só com a flag explícita
 * `--informativo-saldo-hoje` (modo legado, ancorado no saldo de hoje), e o relatório a rotula NÃO OFICIAL.
 */
export type ModoAncora = 'oficial' | 'nao_oficial_saldo_hoje';
export function exigirAncoraOmie(dados: Pick<Dados, 'posicaoAbertura'>, informativoSaldoHoje: boolean): ModoAncora {
  if (dados.posicaoAbertura) return 'oficial';
  if (informativoSaldoHoje) return 'nao_oficial_saldo_hoje';
  throw new ErroDadosReplay(
    'ANCORA_OMIE_AUSENTE: falta a posição datada do Omie na véspera do aquecimento (rode extrair-omie-posicao.ts); o modo legado ancorado no saldo de hoje só roda com --informativo-saldo-hoje e sai NÃO OFICIAL',
  );
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

  // R30: a rodada oficial exige a âncora do Omie; o legado só com a flag e rotulado NÃO OFICIAL
  const modoAncora = exigirAncoraOmie(dados, a['informativo-saldo-hoje'] === true);
  if (modoAncora !== 'oficial') log('ÂNCORA: saldo de hoje (modo legado, --informativo-saldo-hoje) — rodada NÃO OFICIAL');

  // achado 14 (§5.1.1): classe recalculada × classe de hoje, antes de tudo o que usa classe
  t = performance.now();
  const validacaoClasse = validarClasse(dados);
  log(`VALIDAÇÃO DE CLASSE: ${validacaoClasse.valorADivergente === null ? 'n/d' : validacaoClasse.valorADivergente.toFixed(2)}% do valor A diverge (máximo ${CLASSE_DIVERGENCIA_MAXIMA_PCT}%)`);
  exigirValidacaoClasse(validacaoClasse);
  marca('classe', t);

  // paridade do F0 (gate R19/R21 + achado 8)
  t = performance.now();
  const parF0 = paridadeF0(dados);
  const parQtd = paridadeQuantidade(dados, (sku) => parametrosNoDia('F0', dados, sku, dados.dataExtracao, QUANTIL_NEUTRO, { calibracao: false }));
  const pct = (n: number, de: number) => (de > 0 ? n / de : null);
  const pr = parF0.primaria;
  const decididas = parQtd.linhas.filter((l) => l.fora === null);
  const donos = [...new Set(decididas.map((l) => grupoDeEmbalagem(dados, l.sku)?.ancora ?? l.sku))].sort();
  const gate: GateParidade = {
    es: pct(pr.dentro.es, pr.comparados.es),
    pp: pct(pr.dentro.pp, pr.comparados.pp),
    max: pct(pr.dentro.max, pr.comparados.max),
    valor: pr.valorMaximoTotal > 0 ? pr.valorDeltaMaximoDivergente / pr.valorMaximoTotal : null,
    decisao: parQtd.gravado,
    estado: { ...parQtd.replay, divergentes: decididas.filter((l) => l.replay === null || Math.abs(l.replay - l.qtdeFinal) > 1e-6).map((l) => l.sku) },
    status: pr.statusConcorda,
    cobertura: { view: parF0.presencaNaView, decisao: { n: decididas.length, de: parQtd.linhas.length } },
    // o MESMO mapa (e cache) que mapasDaAvaliacao entrega ao F0 do baseline
    paramsBaseline: conferirParamsDoBaseline(dados, preAval('F0', dados, QUANTIL_NEUTRO, undefined), donos, QUANTIL_NEUTRO),
  };
  const falhasGate = falhasDoGate(gate);
  const gatePassa = falhasGate.length === 0;
  log(`GATE_PARIDADE ${gatePassa ? 'PASSA' : `FALHA (${falhasGate.join('; ')})`}: ES ${gate.es} PP ${gate.pp} máx ${gate.max} valor ${gate.valor} decisão ${gate.decisao.n}/${gate.decisao.de} estado ${gate.estado.n}/${gate.estado.de} [${gate.estado.divergentes.join(', ')}] status ${gate.status?.n}/${gate.status?.de} view ${gate.cobertura.view.n}/${gate.cobertura.view.de} params ${gate.paramsBaseline.n}/${gate.paramsBaseline.de}`);
  exigirGateParidade(gate); // FALHA ⇒ ErroDadosReplay ⇒ rc ≠ 0, antes da calibração (review I-3)
  marca('paridade', t);

  /** Grava o OFICIAL, depois roda a informativa (R27) e regrava; erro na informativa fica registrado (M-1). */
  const finalizar = async (oficial: Rodada): Promise<void> => {
    const gravar = (r: Rodada) => {
      escreverRelatorio(r, saida);
      writeFileSync(join(dirname(saida), 'rodada.json'), JSON.stringify(r, (_k, v: unknown) => (v instanceof Set ? [...v] : v instanceof Map ? [...v] : v)));
    };
    const ti = performance.now();
    const temposInf: Record<string, number> = {};
    const r = await anexarInformativa(oficial, () => rodadaInformativa(dados, dir, paralelo, temposInf), gravar);
    for (const [k, v] of Object.entries(temposInf)) r.tempos[`informativo.${k}`] = v;
    r.tempos.informativo = (performance.now() - ti) / 1000;
    r.segundos = (performance.now() - t0) / 1000;
    gravar(r);
    if (r.informativoErro) log(`[informativo R27] FALHOU (o veredito oficial não é afetado): ${r.informativoErro}`);
  };

  // 2. calibração OFICIAL (alvo na célula da classe)
  t = performance.now();
  const of = calibrarNoModo(dados, 'classe');
  const { base, resultados, candidata, fronteira } = of;
  marca('calibracao', t);

  // R27: diagnóstico de plausibilidade (parte do relatório oficial: a causa do veredito)
  t = performance.now();
  const diagnostico = diagnosticar(dados, base);
  marca('diagnostico', t);

  const comum = {
    geradoEm: new Date().toISOString(),
    nomeMetrica: NOME_METRICA_SERVICO,
    chave: {
      hashDados: dados.hashDados, hashCodigo: hashCodigo(), dataExtracao: dados.dataExtracao,
      calendario: 'seg–sex sem feriados; atendimento = du ∪ dias com venda', janelas: JANELAS,
      precisao: { trajetoriasF2: TSB.trajetorias, bootstrap: PRECISAO.bootstrapReamostragens, repsCalibracao: REPS_CALIBRACAO, ...PRECISAO },
    },
    coorte: { populacao: c.populacao.size, alterados: c.alterados.size, todos: ct.populacao.size, excluidosInsumo: c.excluidos },
    paridade: { f0: parF0, quantidade: parQtd, gate, gatePassa, allowlistEstado: ESTADO_DIVERGENTE_PERMITIDO },
    modoAncora,
    validacaoClasse,
    calibracao: { alvo: base.alvo, fillF0: base.fillF0, resultados, candidata },
    fronteira,
    diagnostico,
    informativo: null,
    informativoErro: null,
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
    log(`VEREDITO ${v.veredito} (${v.motivos.join('; ')}) → ${saida}`);
    await finalizar(rodada);
    return 0;
  }
  const rc = resultados.find((x) => x.formula === candidata)!;
  const cg: Congelado = Object.freeze({ candidata, params: structuredClone(rc.params) });

  const av = await avaliarCandidata(dados, dir, cg, vc, { paralelo, tempos });
  const vf = av.veredito;
  const L = { n: av.avaliacao.reps };
  const rodada: Rodada = { ...comum, congelado: cg, veredito: vf, avaliacao: av.avaliacao, tempos, segundos: (performance.now() - t0) / 1000 };
  log(`VEREDITO ${vf.veredito} (${L.n} reps, ${((performance.now() - t0) / 1000).toFixed(1)} s) → ${saida}`);
  for (const m of vf.motivos.slice(0, 40)) log(`  motivo: ${m}`);
  await finalizar(rodada);
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
