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
import { addDias, diffDias } from '../../src/lib/reposicao/orcamento-compra/datas';
import { duAte, type CenarioLT } from './aleatorio';
import {
  avaliarNaCalibracao,
  baseDaCalibracao,
  calibrar,
  CLASSES,
  escolherCandidata,
  estoqueComparavel,
  estoqueDaJanela,
  vereditoDaCalibracao,
  fillDaCelula,
  mapaMisto,
  mediaSomas,
  populacaoDoModo,
  reducaoRelativa,
  REPS_CALIBRACAO,
  somarSomas,
  type CelulasAlvo,
  type ResultadoCalibracao,
} from './calibracao';
import { classeEfetiva, validarClasse, type ValidacaoClasse } from './classe';
import { CENARIOS_FALTA, COLD_START, GRADE_CUSTO, GRADE_QUANTIS, INICIO_AQUECIMENTO, JANELAS, NOME_METRICA_SERVICO, PRECISAO, TSB } from './config';
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
import { dentroDaTolerancia, diagnosticoF0, grupoDeEmbalagem, hashCodigo, parametrosNoDia, paridadeF0, preComputar, preComputarComOrigem, type Formula, type ParamsDia, type ParamsFormula } from './formulas';
import { custoFaltaEquilibrio, custoLiquido, fracaoGrupos, fracaoNaoValorada, fracoesPorFonte, type GradeCusto } from './metricas';
import { coorte, coorteTodosAtivos } from './parados';
import { diagnosticoEstadoInicial, negativosNaAvaliacao, reconstruirSkus, type CenarioInicial } from './reconstrucao';
import { escreverRelatorio, type Diagnostico, type Rodada } from './relatorio';
import { CELULAS, paridadeQuantidade, precoCapitalNoDia, simular, type Celula, type Falta, type SomasSemanais } from './simulador';
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
  // R46: sensibilidade com as linhas PEDIDA_DA_NF DENTRO da amostra de LT do sorteio (só tabela; fora do veredito)
  for (const falta of FALTAS) out.push({ pop: 'coorte', inicial: 'reconstruido', lt: 'empirico_com_nf', falta, sub: false });
  return out;
}
/** Cenários cuja meia largura MC é controlada (os que entram nos critérios do veredito principal). */
const naPrecisao = (c: Cenario): boolean => c.pop === 'coorte' && c.inicial === 'reconstruido' && !c.sub && (c.lt === 'empirico' || c.lt === 'estresse15');
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
  porRep: Record<string, { delta: Record<string, (number | null)[]>; reducao: (number | null)[] }>;
}

export function rodarLote(dados: Dados, cg: Congelado, reps: readonly number[], cacheDir?: string | null): Lote {
  const mapas = mapasDaAvaliacao(dados, cg, cacheDir);
  const lote: Lote = { n: 0, somas: {}, porRep: {} };
  for (const rep of reps) rodarRep(lote, dados, cg, mapas, rep);
  return lote;
}

/**
 * O mesmo lote de `rodarLote`, na mesma ordem de soma, mas devolvendo o event loop entre as repetições: no worker do
 * vitest, minutos de CPU síncrona sem ceder estouram o RPC `onTaskUpdate` (job `testes` do #3411, 2 tentativas).
 */
async function rodarLoteCedendo(dados: Dados, cg: Congelado, reps: readonly number[], cacheDir?: string | null): Promise<Lote> {
  const mapas = mapasDaAvaliacao(dados, cg, cacheDir);
  const lote: Lote = { n: 0, somas: {}, porRep: {} };
  for (const rep of reps) {
    await new Promise<void>((ok) => setImmediate(ok));
    rodarRep(lote, dados, cg, mapas, rep);
  }
  return lote;
}

function rodarRep(lote: Lote, dados: Dados, cg: Congelado, mapas: ReturnType<typeof mapasDaAvaliacao>, rep: number): void {
  const janela: [string, string] = [JANELAS.avaliacaoIni, JANELAS.avaliacaoFim];
  {
    for (const c of cenariosDaAvaliacao()) {
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
        // I2: a redução do subtotal valorado não entra na precisão; estoque sem CMC ⇒ null (estoque fora da precisão)
        pr.reducao.push(reducaoRelativa(estoqueComparavel(s1), estoqueComparavel(s0)));
      }
    }
    lote.n++;
  }
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
  if (paralelo <= 1) return rodarLoteCedendo(dados, cg, reps, cacheDir);
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
    let e: number | null = 0;
    for (const v of Object.values(l.porRep)) {
      for (const cel of CELULAS_SERVICO) {
        const xs = v.delta[cel].filter((x): x is number => x !== null);
        if (xs.length === v.delta[cel].length && xs.length > 1) s = Math.max(s, meiaLarguraMC(xs));
      }
      const rs = v.reducao.filter((x): x is number => x !== null);
      // I2: alguma rep sem redução mensurável ⇒ a precisão do estoque não é medida (null), nunca do subtotal
      if (rs.length !== v.reducao.length) e = null;
      else if (e !== null) e = Math.max(e, meiaLarguraMC(rs));
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
    log(`reps ${reps}: meia largura serviço ${(meiaServ * 100).toFixed(3)} p.p., estoque ${meiaEst === null ? 'não mensurável (estoque sem CMC)' : `${(meiaEst * 100).toFixed(3)} p.p.`} (${((performance.now() - tl) / 1000).toFixed(1)} s)`);
    // estoque não mensurável: não há precisão de estoque a perseguir (o critério de capital já é INCERTO e a linha Precisão também)
    if (meiaServ <= PRECISAO.meiaLarguraServico && (meiaEst === null || meiaEst <= PRECISAO.meiaLarguraEstoque)) break;
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
      fontes: { f0: fracoesPorFonte(m.f0), alt: fracoesPorFonte(m.alt) },
      galao: { f0: servicoDoGalao(m.f0), alt: servicoDoGalao(m.alt) },
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
      // I2: DIO só com estoque todo valorado
      dio: (() => {
        const e0 = estoqueComparavel(mBase.f0);
        const e1 = estoqueComparavel(mBase.alt);
        return cmvDia === null || e0 === null || e1 === null ? null : { f0: e0 / cmvDia, alt: e1 / cmvDia, linhasSemCmc: semCmc };
      })(),
      suaves: { n: suaves.size, f0: fillSuaves(accB!), fnPura: fillSuaves(accP!) },
      nulos,
      skusSemCmc: mBase.f0.skusSemCmc,
      skusCompraReal: mBase.f0.skusCompraReal,
      skusCmcOmie: mBase.f0.skusCmcOmie,
      excluidosSimulacao: mBase.f0.excluidos,
      linhasIgnoradas: mBase.f0.linhasIgnoradas,
    },
  };
}

// ── calibração por modo, fronteira, diagnóstico e rodada informativa (R27) ──────────────────────────────────────────
interface Calibracao {
  base: ReturnType<typeof baseDaCalibracao>;
  resultados: ResultadoCalibracao[];
  candidata: Formula | 'NENHUMA' | 'INDETERMINADA';
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
    const red = reducaoRelativa(r.estoqueMedio, r.estoqueF0);
    log(`${rot}calibrar ${f}: ${JSON.stringify(r.params)} inviável=${r.inviavel} redução=${red === null ? 'não mensurável (estoque sem CMC)' : red.toFixed(4)} (${((performance.now() - tf) / 1000).toFixed(1)} s)`);
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
      fronteira.push({ formula: r.formula, params: p, fill: { ...av.fill, total: fillDaCelula(av.somas, 'total') }, reducao: reducaoRelativa(av.estoque, base.estoqueF0) });
    }
  }
  return { base, resultados, candidata, vc: vereditoDaCalibracao(resultados), fronteira };
}

/** R27: rodada INFORMATIVA NÃO OFICIAL — alvo e tabela §6.1 nas células *_alt (população simulada = só os alterados). */
async function rodadaInformativa(dados: Dados, dir: string, paralelo: number, tempos: Record<string, number>): Promise<NonNullable<Rodada['informativo']>> {
  let t = performance.now();
  const cal = calibrarNoModo(dados, 'alt');
  tempos.calibracao = (performance.now() - t) / 1000;
  const calibracao = { alvo: cal.base.alvo, fillF0: cal.base.fillF0, resultados: cal.resultados, candidata: cal.candidata, capitalF0: capitalDaBase(cal.base) };
  if (cal.candidata === 'NENHUMA' || cal.candidata === 'INDETERMINADA' || cal.vc?.veredito === 'NO-GO') {
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

/** N7: serviço das linhas do galão extra (informativo; fora das células). null = sem linha na janela. */
function servicoDoGalao(s: SomasSemanais): { linhas: number; fill: number | null } | null {
  const x = s.servicoExtras;
  return x.linhas > 0 ? { linhas: x.linhas, fill: x.integrais / x.linhas } : null;
}

/** R44: de onde vem o preço do capital do F0 na calibração (frações de unidades × dias e contagem de SKUs). */
function capitalDaBase(base: ReturnType<typeof baseDaCalibracao>): NonNullable<Rodada['calibracao']['capitalF0']> {
  return { fontes: fracoesPorFonte(base.somasF0), skusSemPreco: base.somasF0.skusSemCmc.length, skusCompraReal: base.somasF0.skusCompraReal.length, skusCmcOmie: base.somasF0.skusCmcOmie.length };
}

/** Diagnóstico de plausibilidade da calibração oficial (R27): A-suaves × A-alterados, semanas, demanda, LT e operação real. */
export function diagnosticar(dados: Dados, base: ReturnType<typeof baseDaCalibracao>): Diagnostico {
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
  // operação real: estoque reconstruído (com ajuste) valorado pelo preço DO DIA, a mesma cadeia do simulador (N2) — e
  // recebido até 30/04. N1 da re-revisão C: estoque sem preço (ou SKU sem reconstrução) ⇒ null, nunca o subtotal valorado.
  const rec = reconstruirSkus(dados);
  let soma: number | null = 0;
  let dias = 0;
  for (let i = diffDias(INICIO_AQUECIMENTO, JANELAS.calibracaoIni); i <= diffDias(INICIO_AQUECIMENTO, JANELAS.calibracaoFim); i++) {
    const d = addDias(INICIO_AQUECIMENTO, i);
    for (const s of c.populacao) {
      if (soma === null) break;
      const it = rec.itens.get(s);
      if (!it) {
        soma = null; // sem estoque reconstruído: ausente ≠ 0
        break;
      }
      const q = it.fimDia[i] + it.ajuste;
      if (Math.abs(q) <= 1e-9) continue;
      const p = precoCapitalNoDia(dados, s, d);
      if (p === null) soma = null;
      else soma += q * p.preco;
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
    real: { estoqueReal: soma === null ? null : soma / dias, estoqueF0: base.estoqueF0, recebidoReal, recebidoF0: m.balanco.recebido },
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
/** Uma divergência de ESTADO: a decisão com os parâmetros do replay ≠ a da produção (achado 8). */
export interface DivergenciaEstado {
  sku: string;
  /** Quem decide (a âncora, no grupo). */
  dono: string;
  replay: number | null;
  qtdeFinal: number;
  /** PP/máximo do F0 do replay no dia da decisão (null = não é F0). */
  estado: { pp: number; max: number } | null;
  /** PP/máximo gravados hoje em produção (sku.hoje). */
  gravado: { pp: number | null; max: number | null };
}

/**
 * Achado 8 + M2: divergência de ESTADO só passa nesta allowlist NOMEADA, e só a divergência PROVADA — o par exato de
 * PP/máximo do replay × PP/máximo gravados medido quando ela foi aceita. Outra divergência do mesmo SKU reprova.
 */
export interface DivergenciaPermitida {
  justificativa: string;
  estado: { pp: number; max: number };
  gravado: { pp: number; max: number };
}
export const ESTADO_DIVERGENTE_PERMITIDO: Readonly<Record<string, DivergenciaPermitida>> = Object.freeze({
  '8689783095': {
    justificativa:
      'R21: PP fixado por humano fora da fórmula — sku_parametros_historico: edicao_manual em 2026-05-14 e aprovacao_humana em 2026-05-21 e 2026-05-27, todos com ponto_pedido 1 (o rótulo edicao_manual sozinho não prova: aparece nas passadas automáticas). Medido em 2026-10-28: replay PP 2/máx 3 × gravado PP 1/máx 2.',
    estado: { pp: 2, max: 3 },
    gravado: { pp: 1, max: 2 },
  },
});
/** Mínimo de concordância de ES/PP/máximo (R19), do status OK e da presença na view (achado 8). */
export const PARIDADE_MINIMA = 0.95;

export interface GateParidade {
  es: number | null;
  pp: number | null;
  max: number | null;
  /** Σ|Δmáximo|·cmc ÷ Σ máximo·cmc nas divergências da primária. */
  valor: number | null;
  /** Quantidade com PP/máximo gravados, em TODAS as linhas comparáveis de sugestao_hoje (R21: deve bater em todas). */
  decisao: { n: number; de: number };
  /**
   * Achado 8 + R42: quantidade com o ESTADO do replay (os parâmetros que o baseline usa), só nas linhas cujo dono está na
   * população simulada; divergentes só na allowlist (M2: a divergência provada).
   */
  estado: { n: number; de: number; divergentes: DivergenciaEstado[] };
  /** R42: o mesmo, nos donos FORA da população simulada — informativo (R20), não reprova. */
  estadoForaDaPopulacao: { n: number; de: number; divergentes: DivergenciaEstado[] };
  /**
   * N5: o ESTADO do replay no dia da decisão (ES do diagnóstico, PP/máximo do mapa do gate) × o gravado em produção
   * (sku_parametros, o que o motor usou — R40) em TODOS os donos da população simulada, com ou sem sugestão positiva;
   * e a sugestão do replay × v_sku_parametros_sugeridos nesses mesmos donos. Limiar e tolerância = os da paridade (R19).
   */
  estadoPopulacao: {
    donos: number;
    gravado: Record<'es' | 'pp' | 'max', { n: number; de: number }>;
    /** M3: donos sem o campo gravado (null em sku_parametros), fora do denominador de `gravado` — contagem visível. */
    semGravado: Record<'es' | 'pp' | 'max', number>;
    view: Record<'es' | 'pp' | 'max', { n: number; de: number }>;
  };
  /**
   * N5 (INFORMATIVO): as decisões de NÃO comprar — donos da população sem sugestão positiva. Elas entram no gate pelo ESTADO
   * (`estadoPopulacao`, limiares da paridade); aqui só se mede quantas são PROVADAS sem a posição do motor (que não é gravada
   * para quem não compra): PP do replay < PP gravado, ou PP e máximo iguais (no F0 da produção, não comprar ⇒ posição ≥ PP
   * gravado; M2: com PP empatado, o máximo dentro da tolerância da paridade; `tipo ≠ F0` NÃO conta como provado). As não
   * provadas são listadas no relatório, não reprovam (R48); `ppAcima` (PP do replay > gravado: o caso que pode virar uma
   * compra que a produção não fez), `semGravado` e `naoF0` têm contagem própria.
   */
  naoComprar: { n: number; de: number; divergentes: DivergenciaEstado[]; ppAcima: number; semGravado: number; naoF0: number };
  /** Concordância do status OK replay × view (primária). null = não medida ⇒ FALHA. */
  status: { n: number; de: number } | null;
  /** Cobertura: presença na view replay × produção; e linhas de sugestao_hoje comparáveis (sem FORA_DOS_DADOS). */
  cobertura: { view: { n: number; de: number }; decisao: { n: number; de: number } };
  /**
   * M3: os parâmetros do gate saem do MESMO preComputar do baseline, estendido até a data da decisão; confere, por dono na
   * população, que esse mapa é idêntico ao do baseline em todos os dias úteis da avaliação.
   */
  paramsBaseline: { n: number; de: number };
}

const fracao = (x: { n: number; de: number } | null): number | null => (x !== null && x.de > 0 ? x.n / x.de : null);
const mesmoPar = (a: { pp: number | null; max: number | null } | null, b: { pp: number; max: number }): boolean =>
  a !== null && a.pp === b.pp && a.max === b.max;

/** M2: a divergência é a provada na allowlist (mesmo SKU E mesmo par de PP/máximo do replay e gravado). */
export function divergenciaPermitida(d: DivergenciaEstado): boolean {
  const p = ESTADO_DIVERGENTE_PERMITIDO[d.sku];
  return p !== undefined && mesmoPar(d.estado, p.estado) && mesmoPar(d.gravado, p.gravado);
}

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
  const fora = e.divergentes.filter((d) => !divergenciaPermitida(d));
  if (fora.length > 0) {
    f.push(`ESTADO_DIVERGENTE_FORA_DA_ALLOWLIST: ${fora.map((d) => `${d.sku} (replay ${d.replay} × prod ${d.qtdeFinal}; estado ${JSON.stringify(d.estado)} × gravado ${JSON.stringify(d.gravado)})`).join(', ')}`);
  }
  for (const [ref, bloco] of [['GRAVADO', g.estadoPopulacao.gravado], ['VIEW', g.estadoPopulacao.view]] as const) {
    for (const k of ['es', 'pp', 'max'] as const) {
      const x = fracao(bloco[k]);
      if (x === null || !(x >= PARIDADE_MINIMA)) f.push(`ESTADO_POPULACAO_${ref}_${k.toUpperCase()}: ${bloco[k].n}/${bloco[k].de}`);
    }
  }
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
 * M3: por SKU, o mapa do gate (o preComputar do baseline estendido até a data da decisão) é idêntico ao mapa do baseline
 * em TODOS os dias úteis que o baseline simulou. SKU ausente de qualquer um conta como divergente.
 */
export function conferirParamsDoBaseline(baseline: ReadonlyMap<string, ParamsDia>, gate: ReadonlyMap<string, ParamsDia>, skus: Iterable<string>): { n: number; de: number } {
  const diasPorSku = new Map<string, string[]>();
  for (const k of baseline.keys()) {
    const c = k.indexOf('|');
    const sku = k.slice(0, c);
    const l = diasPorSku.get(sku) ?? [];
    l.push(k.slice(c + 1));
    diasPorSku.set(sku, l);
  }
  const out = { n: 0, de: 0 };
  for (const sku of skus) {
    out.de++;
    const dias = diasPorSku.get(sku) ?? [];
    if (dias.length > 0 && dias.every((d) => {
      const g = gate.get(`${sku}|${d}`);
      return g !== undefined && JSON.stringify(g) === JSON.stringify(baseline.get(`${sku}|${d}`));
    })) out.n++;
  }
  return out;
}

export interface ResultadoGate {
  parF0: ReturnType<typeof paridadeF0>;
  parQtd: ReturnType<typeof paridadeQuantidade>;
  gate: GateParidade;
  /** M3: os parâmetros F0 do replay usados na decisão, por dono, na data da decisão (= dataExtracao, dia de SP, R40). */
  paramsDecisao: Map<string, ParamsDia>;
}

/**
 * Monta o gate de paridade do F0 (achado 8, R42, M2, M3). A decisão da produção é a da execução do motor do dia da
 * extração (R40: dataExtracao é o dia de SP, e a carga garante que não houve passada depois do motor). Os parâmetros do
 * replay nesse dia saem do preComputar do baseline estendido até ele (donos na população); fora dela, informativos.
 */
export function montarGate(dados: Dados, opcoes: { cacheDir?: string | null } = {}): ResultadoGate {
  const parF0 = paridadeF0(dados);
  const d = dados.dataExtracao;
  const simulados = coorteTodosAtivos(dados).populacao;
  const donoDe = (sku: string) => grupoDeEmbalagem(dados, sku)?.ancora ?? sku;
  // N5: TODOS os donos da população simulada (com ou sem sugestão positiva), não só os de sugestao_hoje
  const donosPop = [...new Set([...simulados].filter((s) => dados.skus.has(s)).map(donoDe))].filter((s) => simulados.has(s) && dados.skus.has(s)).sort();
  const cache = opcoes.cacheDir === undefined ? {} : { cacheDir: opcoes.cacheDir };
  const mapaGate = donosPop.length === 0
    ? new Map<string, ParamsDia>()
    : preComputarComOrigem('F0', dados, QUANTIL_NEUTRO, { calibracao: false, dias: [INICIO_AQUECIMENTO, d], skus: donosPop }, cache).mapa;
  const paramsDecisao = new Map<string, ParamsDia>();
  const paramsHoje = (dono: string): ParamsDia => {
    if (!simulados.has(dono)) return parametrosNoDia('F0', dados, dono, d, QUANTIL_NEUTRO, { calibracao: false }); // informativo (R42)
    const p = mapaGate.get(`${dono}|${d}`);
    if (p === undefined) throw new ErroDadosReplay(`DATA_DECISAO_SEM_PARAMETRO: ${dono}|${d} (a data da decisão precisa ser dia útil)`);
    paramsDecisao.set(dono, p);
    return p;
  };
  const parQtd = paridadeQuantidade(dados, paramsHoje);
  const pct = (n: number, de: number) => (de > 0 ? n / de : null);
  const pr = parF0.primaria;
  const decididas = parQtd.linhas.filter((l) => l.fora === null);
  const bloco = (dentro: boolean): GateParidade['estado'] => {
    const ls = decididas.filter((l) => simulados.has(donoDe(l.sku)) === dentro);
    const div = ls.filter((l) => l.replay === null || Math.abs(l.replay - l.qtdeFinal) > 1e-6);
    return {
      n: ls.length - div.length,
      de: ls.length,
      divergentes: div.map((l) => {
        const dono = donoDe(l.sku);
        const p = paramsHoje(dono);
        const s = dados.skus.get(dono)!;
        return { sku: l.sku, dono, replay: l.replay, qtdeFinal: l.qtdeFinal, estado: p.tipo === 'F0' ? { pp: p.pp, max: p.max } : null, gravado: { pp: s.hoje.pp, max: s.hoje.max } };
      }),
    };
  };
  // N5: estado (replay × gravado) e sugestão (replay × view) em todos os donos da população; decisões de não comprar
  const contagem = () => ({ es: { n: 0, de: 0 }, pp: { n: 0, de: 0 }, max: { n: 0, de: 0 } });
  const estadoPopulacao: GateParidade['estadoPopulacao'] = { donos: donosPop.length, gravado: contagem(), semGravado: { es: 0, pp: 0, max: 0 }, view: contagem() };
  for (const dono of donosPop) {
    const p = paramsHoje(dono);
    const s = dados.skus.get(dono)!;
    const es = diagnosticoF0(dados, dono, d, { calibracao: false }).es ?? (p.tipo === 'F0' ? COLD_START.es : null);
    const rep = { es, pp: p.tipo === 'F0' ? p.pp : null, max: p.tipo === 'F0' ? p.max : null };
    for (const k of ['es', 'pp', 'max'] as const) {
      if (s.hoje[k] === null) {
        estadoPopulacao.semGravado[k]++;
        continue;
      }
      estadoPopulacao.gravado[k].de++;
      if (dentroDaTolerancia(s.hoje[k], rep[k])) estadoPopulacao.gravado[k].n++;
    }
  }
  const prPop = paridadeF0(dados, donosPop).primaria;
  for (const k of ['es', 'pp', 'max'] as const) estadoPopulacao.view[k] = { n: prPop.dentro[k], de: prPop.comparados[k] };
  const comSugestao = new Set(decididas.map((l) => donoDe(l.sku)));
  const naoComprar: GateParidade['naoComprar'] = { n: 0, de: 0, divergentes: [], ppAcima: 0, semGravado: 0, naoF0: 0 };
  for (const dono of donosPop) {
    if (comSugestao.has(dono)) continue;
    const p = paramsHoje(dono);
    const s = dados.skus.get(dono)!;
    naoComprar.de++;
    const gp = s.hoje.pp;
    if (p.tipo !== 'F0') naoComprar.naoF0++;
    else if (gp === null) naoComprar.semGravado++;
    else if (p.pp > gp) naoComprar.ppAcima++;
    // M2: sem evidência (tipo ≠ F0) não é provado; com PP empatado, basta o máximo dentro da tolerância da paridade
    const provado = p.tipo === 'F0' && gp !== null && (p.pp < gp || (p.pp === gp && dentroDaTolerancia(s.hoje.max, p.max)));
    if (provado) naoComprar.n++;
    else naoComprar.divergentes.push({ sku: dono, dono, replay: null, qtdeFinal: 0, estado: p.tipo === 'F0' ? { pp: p.pp, max: p.max } : null, gravado: { pp: s.hoje.pp, max: s.hoje.max } });
  }
  const gate: GateParidade = {
    es: pct(pr.dentro.es, pr.comparados.es),
    pp: pct(pr.dentro.pp, pr.comparados.pp),
    max: pct(pr.dentro.max, pr.comparados.max),
    valor: pr.valorMaximoTotal > 0 ? pr.valorDeltaMaximoDivergente / pr.valorMaximoTotal : null,
    decisao: parQtd.gravado,
    estado: bloco(true),
    estadoForaDaPopulacao: bloco(false),
    estadoPopulacao,
    naoComprar,
    status: pr.statusConcorda,
    cobertura: { view: parF0.presencaNaView, decisao: { n: decididas.length, de: parQtd.linhas.length } },
    // o MESMO preComputar (e cache) que mapasDaAvaliacao entrega ao F0 do baseline
    paramsBaseline: conferirParamsDoBaseline(preAval('F0', dados, QUANTIL_NEUTRO, opcoes.cacheDir), mapaGate, donosPop),
  };
  return { parF0, parQtd, gate, paramsDecisao };
}

/**
 * Passos ANTES da calibração, nesta ordem e fail-closed (M1: a fiação é testada, não só as funções): âncora Omie (R30),
 * validação de classe (achado 14, §5.1.1) e gate de paridade (achado 8). Qualquer um que reprova lança ErroDadosReplay.
 */
export function etapasPreCalibracao(
  dados: Dados,
  o: { informativoSaldoHoje: boolean; cacheDir?: string | null; log?: (m: string) => void },
): ResultadoGate & { modoAncora: ModoAncora; validacaoClasse: ValidacaoClasse; gatePassa: boolean } {
  const lg = o.log ?? log;
  const modoAncora = exigirAncoraOmie(dados, o.informativoSaldoHoje, skusQueExigemAncora(dados));
  if (modoAncora !== 'oficial') lg('ÂNCORA: saldo de hoje (modo legado, --informativo-saldo-hoje) — rodada NÃO OFICIAL');
  const validacaoClasse = validarClasse(dados);
  lg(`VALIDAÇÃO DE CLASSE: ${validacaoClasse.valorADivergente === null ? 'n/d' : validacaoClasse.valorADivergente.toFixed(2)}% do valor A diverge (máximo ${CLASSE_DIVERGENCIA_MAXIMA_PCT}%)`);
  exigirValidacaoClasse(validacaoClasse);
  const r = montarGate(dados, o.cacheDir === undefined ? {} : { cacheDir: o.cacheDir });
  const g = r.gate;
  const falhas = falhasDoGate(g);
  const fora = g.estadoForaDaPopulacao;
  lg(
    `GATE_PARIDADE ${falhas.length === 0 ? 'PASSA' : `FALHA (${falhas.join('; ')})`}: ES ${g.es} PP ${g.pp} máx ${g.max} valor ${g.valor} decisão ${g.decisao.n}/${g.decisao.de} ` +
      `estado ${g.estado.n}/${g.estado.de} [${g.estado.divergentes.map((x) => x.sku).join(', ')}] fora da população ${fora.n}/${fora.de} [${fora.divergentes.map((x) => x.sku).join(', ')}] ` +
      `status ${g.status?.n}/${g.status?.de} view ${g.cobertura.view.n}/${g.cobertura.view.de} params ${g.paramsBaseline.n}/${g.paramsBaseline.de} ` +
      `população ${g.estadoPopulacao.donos} donos (sem gravado ES/PP/máx ${g.estadoPopulacao.semGravado.es}/${g.estadoPopulacao.semGravado.pp}/${g.estadoPopulacao.semGravado.max}): gravado ES ${g.estadoPopulacao.gravado.es.n}/${g.estadoPopulacao.gravado.es.de} PP ${g.estadoPopulacao.gravado.pp.n}/${g.estadoPopulacao.gravado.pp.de} máx ${g.estadoPopulacao.gravado.max.n}/${g.estadoPopulacao.gravado.max.de} · ` +
      `view ES ${g.estadoPopulacao.view.es.n}/${g.estadoPopulacao.view.es.de} PP ${g.estadoPopulacao.view.pp.n}/${g.estadoPopulacao.view.pp.de} máx ${g.estadoPopulacao.view.max.n}/${g.estadoPopulacao.view.max.de} · ` +
      `não comprar provadas ${g.naoComprar.n}/${g.naoComprar.de} (PP do replay > gravado ${g.naoComprar.ppAcima}, sem gravado ${g.naoComprar.semGravado}, não F0 ${g.naoComprar.naoF0}) [${g.naoComprar.divergentes.map((x) => x.sku).join(', ')}]`,
  );
  exigirGateParidade(g); // FALHA ⇒ ErroDadosReplay ⇒ rc ≠ 0, antes da calibração (review I-3)
  return { ...r, modoAncora, validacaoClasse, gatePassa: falhas.length === 0 };
}

/** I1 (R30): o veredito gravado em rodada.json carrega o modo da âncora. */
export function vereditoComModo(v: { veredito: VereditoReplay; motivos: string[] }, modo: ModoAncora): Rodada['veredito'] {
  return { ...v, modo };
}

/** I1 (R30): a linha do VEREDITO no log carrega o modo; no legado, NÃO OFICIAL. */
export function linhaVeredito(v: VereditoReplay, modo: ModoAncora): string {
  return modo === 'oficial' ? `VEREDITO ${v}` : `VEREDITO NÃO OFICIAL (R30, âncora no saldo de hoje) ${v}`;
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
/**
 * N6: a âncora tem de cobrir TODA a população que a rodada simula — a coorte, todos os ativos (gate, R27) e os membros de
 * grupo das âncoras (o galão extra) que estão nos dados. Um SKU sem posição seria excluído da simulação e levaria junto a
 * demanda dele (o serviço melhora por exclusão): a rodada para, nunca exclui.
 */
export function skusQueExigemAncora(dados: Dados): string[] {
  const out = new Set<string>([...coorte(dados).populacao, ...coorteTodosAtivos(dados).populacao].filter((s) => dados.skus.has(s)));
  for (const s of [...out]) {
    const g = grupoDeEmbalagem(dados, s);
    if (g && g.ancora === s) for (const m of g.membros) if (dados.skus.has(m)) out.add(m);
  }
  return [...out].sort();
}
export function exigirAncoraOmie(dados: Pick<Dados, 'posicaoAbertura'>, informativoSaldoHoje: boolean, necessarios: Iterable<string>): ModoAncora {
  const pos = dados.posicaoAbertura;
  if (pos) {
    const faltam = [...necessarios].filter((s) => !pos.has(s)).sort();
    if (pos.size === 0 || faltam.length > 0) {
      throw new ErroDadosReplay(`ANCORA_OMIE_INCOMPLETA: ${pos.size === 0 ? 'posição de abertura VAZIA; ' : ''}${faltam.length} SKU(s) da população sem posição na abertura: ${faltam.join(', ')}`);
    }
    return 'oficial';
  }
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

  // pré-calibração, nesta ordem e fail-closed: âncora (R30) → classe (achado 14) → gate de paridade (achado 8)
  t = performance.now();
  const { modoAncora, validacaoClasse, parF0, parQtd, gate, gatePassa } = etapasPreCalibracao(dados, { informativoSaldoHoje: a['informativo-saldo-hoje'] === true });
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
    calibracao: { alvo: base.alvo, fillF0: base.fillF0, resultados, candidata, capitalF0: capitalDaBase(base) },
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
  // I2: INDETERMINADA (capital não valorado na calibração) também para aqui, com o INCONCLUSIVO do vereditoDaCalibracao
  if (candidata === 'NENHUMA' || candidata === 'INDETERMINADA' || vc?.veredito === 'NO-GO') {
    const v = vc ?? { veredito: 'NO-GO' as const, motivos: ['INVIAVEL_NA_CALIBRACAO'] };
    const rodada: Rodada = { ...comum, congelado: null, veredito: vereditoComModo(v, modoAncora), avaliacao: null, tempos, segundos: (performance.now() - t0) / 1000 };
    log(`${linhaVeredito(v.veredito, modoAncora)} (${v.motivos.join('; ')}) → ${saida}`);
    await finalizar(rodada);
    return 0;
  }
  const rc = resultados.find((x) => x.formula === candidata)!;
  const cg: Congelado = Object.freeze({ candidata, params: structuredClone(rc.params) });

  const av = await avaliarCandidata(dados, dir, cg, vc, { paralelo, tempos });
  const vf = av.veredito;
  const L = { n: av.avaliacao.reps };
  const rodada: Rodada = { ...comum, congelado: cg, veredito: vereditoComModo(vf, modoAncora), avaliacao: av.avaliacao, tempos, segundos: (performance.now() - t0) / 1000 };
  log(`${linhaVeredito(vf.veredito, modoAncora)} (${L.n} reps, ${((performance.now() - t0) / 1000).toFixed(1)} s) → ${saida}`);
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
