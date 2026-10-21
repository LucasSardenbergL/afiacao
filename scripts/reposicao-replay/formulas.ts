// Parâmetros das fórmulas F0–F3 do replay TSB (spec §5.3 e §5.9 "Equações", "Lead time", "Precisão e cache").
//
// F0 = o motor de HOJE, reproduzido da definição de PRODUÇÃO (psql-ro, 2026-10-21), não da memória:
//  · demanda d (v_sku_demanda_estatisticas): Σ quantidade com data >= hoje-90 dias CORRIDOS ÷ 90, round 4. O cron roda
//    ~01:15 de SP, então "hoje" não tem venda: o replay usa [d-90, d).
//  · σd (v_sku_sigma_demanda): stddev_samp da série de 180 dias CORRIDOS [d-180, d-1] COM ZEROS, round 4; só existe para
//    SKU com venda na janela; ausente → d·0,5 (COALESCE da view).
//  · LT (v_sku_leadtime_estatisticas): v_sku_leadtime_efetivo (dedup por NFe, LT NULL quando as cópias divergem) com
//    t2 >= hoje-180; SKU com >= 3 obs usa média/desvio próprios (round 2), senão os do fornecedor; LT = GREATEST(LT teórico
//    do grupo, LT histórico); σLT = COALESCE(desvio, desvio do fornecedor, COALESCE(teórico, 10)·0,3).
//  · z e mínimo operacional pela classe ABC PROPOSTA do dia (Pareto de v_sku_classificacao_abc_xyz, SEM histerese) —
//    é o que a view faz (CASE c.classe_abc_proposta), e diverge do texto do brief ("classeEfetiva"): manda a produção.
//  · ss = ceil(z·σLTd); pp = ceil(d·LT + z·σLTd); EOQ = ceil(√(2·d·252·cp / (cm·preço))) (ou 1);
//    mínimo = max(ss, mín. operacional); PP = max(pp, mínimo + 1); máximo = PP + max(EOQ, 1); gate status_sugestao.
//  · gravação (atualizar_parametros_numericos_skus, 1×/dia): só muda o gravado se 'aplicado' — sugestão nula, PP e
//    máximo iguais (arredondados), validação, ou fusível (máximo > 3× o anterior → 'segurado') mantêm o anterior. O SKU
//    que sai da view (sem venda em 90 dias) NÃO é recalculado: congela pp/máximo e a demanda da linha.
//  · teto B/C (db/embalagem-motor-rpc.sql ~L462): dias por classe EFETIVA (histerese + forçada), só sem grupo e sem mínimo
//    forçado; demanda da linha = sp.demanda_media_diaria gravada.
//  · grupo de embalagem: a âncora (fator_para_base = 1) decide com os PRÓPRIOS parâmetros (demanda só dela — é o motor) e
//    sem teto; o membro com fator > 1 nunca é âncora (SEM_DECISAO). O estoque consolidado é da Task 6.
// LIMITAÇÕES do F0 (relatório): sem preço de compra real (o extrato não traz valor do recebimento: cmc de hoje → venda×0,55);
// t4 como proxy de t2 na janela de LT; NFe aproximada por (SKU, t4); origem_compra não filtrada; nº de ordens = nº de
// linhas; t1 "fabricado" (= t2, lt_bruto NULL em prod) não é identificável no extrato; demanda de insumo da ficha técnica
// (v_sku_demanda_efetiva) não está no extrato. O estado ANTES do replay não existe: até a 1ª sugestão OK vale o fallback
// do cold start (pp 1 / máx. 2 / ES 0, a regra do motor para SKU sem demanda); a 1ª sugestão OK o substitui sem fusível
// (graduação revisada); antes de 28 dias observados o motor não roda (vale o cold start).
//
// F1–F3 (spec §5.9) na unidade-base do grupo (a demanda dos membros soma; todos em L no dado real), dias úteis (venda de
// fim de semana conta no dia útil ANTERIOR — nunca vaza: só entra para d posterior a ela), LT documental com t4 < d.
// Histórico insuficiente (< 2 dias úteis positivos, ou sem LT) → os parâmetros do F0.
//
// MUDANÇA DE TIPO (documentada para a Task 6): `ParamsDia` ganhou `{ tipo: 'SEM_DECISAO'; motivo }` (galão não-âncora; SKU
// fora dos dados) e `demandaDiariaLinha` é `number | null` (ausente ≠ zero; o motor faz COALESCE(…, 0) > 0 no teto).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDias, diffDias, ehDiaUtil } from '../../src/lib/reposicao/orcamento-compra/datas';
import { uniformePar } from './aleatorio';
import { classeEfetiva, classeProposta } from './classe';
import {
  COLD_START,
  F0,
  F1_JANELA_DU,
  FUSIVEL_PARAM_MULT,
  GRADE_QUANTIS,
  INICIO_AQUECIMENTO,
  JANELAS,
  LT_TEORICO_DU,
  MIN_RECEBIMENTOS_SKU_LT,
  MINIMO_OPERACIONAL_POR_CLASSE,
  TSB,
} from './config';
import { coorte, coorteTodosAtivos } from './parados';
import { ErroDadosReplay, type Classe, type Dados, type Data, type Sku } from './tipos';

// ── tipos públicos ───────────────────────────────────────────────────────────────────────────────────────────────
export type Formula = 'F0' | 'F1' | 'F2' | 'F3';
export type Beta = 0.005 | 0.01 | 0.02;
export interface ParamsFormula {
  beta?: Beta;
  janelaDias?: 60 | 90 | 180;
  quantil: Record<Classe, number>;
}
export interface ParamsF0 {
  tipo: 'F0';
  pp: number;
  max: number;
  /** Dias do teto B/C; null = sem teto (classe A/ausente, grupo, mínimo forçado, flag desligada). */
  coberturaTetoDias: number | null;
  /** sp.demanda_media_diaria gravada; null = nunca esteve na view. */
  demandaDiariaLinha: number | null;
}
export type MotivoSemDecisao = 'MEMBRO_GRUPO_NAO_ANCORA' | 'F0_SEM_PARAMETRO';
export interface SemDecisao {
  tipo: 'SEM_DECISAO';
  motivo: MotivoSemDecisao;
}
export type ParamsDia = ParamsF0 | { tipo: 'S'; s: number } | SemDecisao;
export interface CtxFormula {
  calibracao: boolean;
  /** Dias (inclusive) do preComputar; padrão: do início do aquecimento ao fim da janela do contexto. */
  dias?: [Data, Data];
  /** SKUs do preComputar; padrão: população "todos os ativos" (⊇ coorte). */
  skus?: string[];
}

const BETAS: readonly Beta[] = TSB.betas as readonly Beta[];

// ── aritmética como o Postgres (numeric) ──────────────────────────────────────────────────────────────────────────
/** round(x, k) do PG: meio para longe do zero. O +1e-9 absorve 1,00005·1e4 = 10000,4999… do double. */
export function arred(x: number, k: number): number {
  const f = 10 ** k;
  return (Math.sign(x) * Math.round(Math.abs(x) * f + 1e-9)) / f;
}
/** ceil sobre o valor arredondado a 9 casas (o PG calcula em decimal exato; o double erra na 16ª casa). */
const teto9 = (x: number): number => Math.ceil(Math.round(x * 1e9) / 1e9);

function media(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s / xs.length;
}
/** stddev_samp; null com < 2 valores. */
function desvioAmostral(xs: ArrayLike<number>): number | null {
  if (xs.length < 2) return null;
  const m = media(xs);
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += (xs[i] - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/** Quantil tipo 7 (interpolação linear) de um vetor ORDENADO crescente. */
export function quantilTipo7(ordenado: ArrayLike<number>, q: number): number {
  const n = ordenado.length;
  if (n === 0) throw new Error('QUANTIL_SEM_DADOS');
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  return ordenado[lo] + (h - lo) * (ordenado[hi] - ordenado[lo]);
}

/** Inversa da normal padrão (Acklam; erro relativo < 1,2e-9). */
export function normalInversa(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`QUANTIL_INVALIDO:${p}`);
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const dd = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((dd[0] * q + dd[1]) * q + dd[2]) * q + dd[3]) * q + 1);
  }
  if (p > 1 - pl) return -normalInversa(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ── índice por `dados` (memo por identidade do objeto) ─────────────────────────────────────────────────────────────
interface Grupo {
  grupoId: string;
  ancora: string;
  membros: string[];
}
interface ObsLtMotor {
  sku: string;
  t4: Data;
  lt: number;
}
interface Indice {
  nDias: number;
  /** Total diário (unidade de estoque) por SKU, dia corrido i = diffDias(INICIO, data). Só vendas no escopo. */
  totalDia: Map<string, Float64Array>;
  /** Prefixos (comprimento nDias+1) de total e de nº de linhas. */
  prefTotal: Map<string, Float64Array>;
  prefLinhas: Map<string, Float64Array>;
  /** Dias corridos com venda (índices crescentes). */
  diasPositivos: Map<string, number[]>;
  /** Linhas (preço de venda) por SKU, ordenadas por data. */
  linhas: Map<string, { i: number; preco: number }[]>;
  /** Dias úteis do início do aquecimento ao horizonte e o "balde" de cada dia corrido (fim de semana → dia útil anterior). */
  du: Data[];
  baldeDoDia: Int32Array;
  grupoDe: Map<string, Grupo>;
  obsMotor: ObsLtMotor[];
  obsMotorPorSku: Map<string, ObsLtMotor[]>;
  maxLtDu: number;
  propostaPorDia: Map<Data, Map<string, Classe>>;
  efetivaPorDia: Map<Data, Map<string, Classe>>;
  fornecedorPorDia: Map<string, { media: number | null; desvio: number | null }>;
  serieDu: Map<string, Float64Array>;
  trajF0: Map<string, TrajetoriaF0>;
  aleatoriosF2: Map<string, { L: Float64Array; B: Float64Array; R: Float64Array; hMax: number }>;
}
const indices = new WeakMap<Dados, Indice>();

const idx = (d: Data): number => diffDias(INICIO_AQUECIMENTO, d);

function indice(dados: Dados): Indice {
  const pronto = indices.get(dados);
  if (pronto) return pronto;
  let fim: Data = JANELAS.avaliacaoFim;
  if (dados.dataExtracao > fim) fim = dados.dataExtracao;
  for (const v of dados.vendas) if (v.data > fim) fim = v.data;
  const nDias = idx(fim) + 2;
  const totalDia = new Map<string, Float64Array>();
  const linhasN = new Map<string, Float64Array>();
  const linhas = new Map<string, { i: number; preco: number }[]>();
  for (const v of dados.vendas) {
    if (!v.noEscopo || !dados.skus.has(v.sku) || v.data < INICIO_AQUECIMENTO) continue;
    const i = idx(v.data);
    let t = totalDia.get(v.sku);
    if (!t) {
      totalDia.set(v.sku, (t = new Float64Array(nDias)));
      linhasN.set(v.sku, new Float64Array(nDias));
      linhas.set(v.sku, []);
    }
    t[i] += v.quantidade;
    linhasN.get(v.sku)![i] += 1;
    if (v.quantidade > 0) linhas.get(v.sku)!.push({ i, preco: v.valor / v.quantidade });
  }
  const pref = (a: Float64Array) => {
    const p = new Float64Array(a.length + 1);
    for (let i = 0; i < a.length; i++) p[i + 1] = p[i] + a[i];
    return p;
  };
  const prefTotal = new Map<string, Float64Array>();
  const prefLinhas = new Map<string, Float64Array>();
  const diasPositivos = new Map<string, number[]>();
  for (const [s, t] of totalDia) {
    prefTotal.set(s, pref(t));
    prefLinhas.set(s, pref(linhasN.get(s)!));
    const pos: number[] = [];
    for (let i = 0; i < t.length; i++) if (t[i] !== 0) pos.push(i);
    diasPositivos.set(s, pos);
    linhas.get(s)!.sort((a, b) => a.i - b.i);
  }
  // dias úteis e baldes
  const du: Data[] = [];
  const baldeDoDia = new Int32Array(nDias).fill(-1);
  for (let i = 0; i < nDias; i++) {
    const d = addDias(INICIO_AQUECIMENTO, i);
    if (ehDiaUtil(d)) du.push(d);
    baldeDoDia[i] = du.length - 1; // fim de semana cai no dia útil anterior (-1 antes do 1º dia útil)
  }
  // grupos de embalagem
  const grupoDe = new Map<string, Grupo>();
  const porGrupo = new Map<string, { sku: string; fpb: number }[]>();
  for (const e of dados.equivalencias ?? []) {
    const l = porGrupo.get(e.grupoId) ?? [];
    if (!l.some((x) => x.sku === e.sku)) l.push({ sku: e.sku, fpb: e.fatorParaBaseSku });
    porGrupo.set(e.grupoId, l);
  }
  for (const [grupoId, ms] of porGrupo) {
    const ancoras = ms.filter((m) => m.fpb === 1);
    if (ancoras.length !== 1) throw new ErroDadosReplay(`GRUPO_EMBALAGEM_SEM_ANCORA_UNICA:${grupoId}`);
    const membros = ms.map((m) => m.sku).filter((s) => dados.skus.has(s)).sort();
    const unidades = new Set(membros.map((s) => dados.skus.get(s)!.unidadeEstoque?.trim().toUpperCase() ?? null));
    if (unidades.size > 1) throw new ErroDadosReplay(`GRUPO_EMBALAGEM_UNIDADE_MISTA:${grupoId}`);
    const g: Grupo = { grupoId, ancora: ancoras[0].sku, membros };
    for (const m of ms) grupoDe.set(m.sku, g);
  }
  // LT do motor: v_sku_leadtime_efetivo deduplica por NFe e anula o LT quando as cópias divergem. Sem a chave da NFe no
  // extrato, a NFe é aproximada por (SKU, t4): cópias com o MESMO LT viram 1 observação; com LTs diferentes, nenhuma.
  const porChave = new Map<string, ObsLtMotor & { ok: boolean }>();
  let maxLtDu = 0;
  for (const it of dados.itensLT) {
    if (it.aberto || it.t4 === null) continue;
    if (it.ltDu > maxLtDu) maxLtDu = it.ltDu;
    const k = `${it.sku}\u0000${it.t4}`;
    const o = porChave.get(k);
    if (!o) porChave.set(k, { sku: it.sku, t4: it.t4, lt: it.ltDu, ok: true });
    else if (o.lt !== it.ltDu) o.ok = false;
  }
  const obsMotor = [...porChave.values()].filter((o) => o.ok).map(({ sku, t4, lt }) => ({ sku, t4, lt }));
  obsMotor.sort((a, b) => (a.t4 < b.t4 ? -1 : a.t4 > b.t4 ? 1 : a.sku < b.sku ? -1 : 1));
  const obsMotorPorSku = new Map<string, ObsLtMotor[]>();
  for (const o of obsMotor) {
    const l = obsMotorPorSku.get(o.sku) ?? [];
    l.push(o);
    obsMotorPorSku.set(o.sku, l);
  }
  const ix: Indice = {
    nDias, totalDia, prefTotal, prefLinhas, diasPositivos, linhas, du, baldeDoDia, grupoDe, obsMotor, obsMotorPorSku, maxLtDu,
    propostaPorDia: new Map(), efetivaPorDia: new Map(), fornecedorPorDia: new Map(), serieDu: new Map(), trajF0: new Map(), aleatoriosF2: new Map(),
  };
  indices.set(dados, ix);
  return ix;
}

function propostaDoDia(dados: Dados, ix: Indice, d: Data): Map<string, Classe> {
  let m = ix.propostaPorDia.get(d);
  if (!m) ix.propostaPorDia.set(d, (m = classeProposta(dados, d)));
  return m;
}
function efetivaDoDia(dados: Dados, ix: Indice, d: Data): Map<string, Classe> {
  let m = ix.efetivaPorDia.get(d);
  if (!m) ix.efetivaPorDia.set(d, (m = classeEfetiva(dados, d)));
  return m;
}

/** Grupo de embalagem do SKU (null = fora de grupo). */
export function grupoDeEmbalagem(dados: Dados, sku: string): { grupoId: string; ancora: string; membros: string[] } | null {
  return indice(dados).grupoDe.get(sku) ?? null;
}

// ── F0 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** σ diário de v_sku_sigma_demanda em d: 180 dias corridos [d-180, d-1] COM zeros (só os observados), round 4. */
export function sigmaDemanda180(dados: Dados, sku: string, d: Data): number | null {
  return sigmaJanela(indice(dados), sku, d);
}
function sigmaJanela(ix: Indice, sku: string, d: Data): number | null {
  const iD = idx(d);
  const ini = Math.max(0, iD - F0.janelaSigmaDias);
  const n = Math.min(iD, ix.nDias) - ini;
  const pos = ix.diasPositivos.get(sku);
  const tot = ix.totalDia.get(sku);
  if (!pos || !tot || n < 2) return null;
  const dentro: number[] = [];
  for (const i of pos) if (i >= ini && i < iD) dentro.push(tot[i]);
  if (dentro.length === 0) return null; // SKU fora de vendas_diarias: a view não tem linha
  const m = dentro.reduce((s, x) => s + x, 0) / n;
  let ss = (n - dentro.length) * m * m;
  for (const x of dentro) ss += (x - m) ** 2;
  return arred(Math.sqrt(ss / (n - 1)), 4);
}

function fornecedorLt(ix: Indice, d: Data, calib: boolean): { media: number | null; desvio: number | null } {
  const k = `${d}|${calib ? 1 : 0}`;
  let r = ix.fornecedorPorDia.get(k);
  if (!r) {
    const ini = addDias(d, -F0.janelaLtDias);
    const xs = ix.obsMotor.filter((o) => o.t4 < d && o.t4 >= ini && (!calib || o.t4 <= JANELAS.calibracaoFim)).map((o) => o.lt);
    const dp = desvioAmostral(xs);
    r = { media: xs.length ? arred(media(xs), 2) : null, desvio: dp === null ? null : arred(dp, 2) };
    ix.fornecedorPorDia.set(k, r);
  }
  return r;
}

type StatusSugestao = 'OK' | 'AGUARDANDO_SEGUNDA_ORDEM' | 'SEM_LEADTIME_DEFINIDO' | 'AGUARDANDO_CLASSIFICACAO_GRUPO' | 'SEM_PRECO';
type StatusGravacao = 'fora_da_view' | 'semeado' | 'aplicado' | 'sem_mudanca' | 'bloqueado_validacao' | 'segurado';
export interface DiagnosticoF0 {
  naView: boolean;
  classeProposta: Classe | null;
  numOrdens: number;
  demanda: number | null;
  sigmaD: number | null;
  lt: number | null;
  sigmaLt: number | null;
  z: number | null;
  minimoOperacional: number | null;
  ssCalculado: number | null;
  ppSugerido: number | null;
  maxSugerido: number | null;
  status: StatusSugestao | null;
  gravacao: StatusGravacao | null;
  /** Gravado em sku_parametros DEPOIS da passada do dia (cold start até a 1ª sugestão OK; null = motor ainda não rodou). */
  coldStart: boolean;
  es: number | null;
  pp: number | null;
  max: number | null;
  demandaGravada: number | null;
}
interface EstadoF0 {
  es: number;
  pp: number;
  max: number;
  min: number;
  coldStart: boolean;
}
const ESTADO_COLD_START: EstadoF0 = { es: COLD_START.es, pp: COLD_START.pp, max: COLD_START.max, min: 1, coldStart: true };
interface TrajetoriaF0 {
  ate: Data | null;
  estado: EstadoF0;
  demanda: number | null;
  dias: Map<Data, DiagnosticoF0>;
}

/** Sugestão de v_sku_parametros_sugeridos para o SKU no dia d (dados < d). */
function sugestaoF0(dados: Dados, ix: Indice, s: Sku, d: Data, calib: boolean): Omit<DiagnosticoF0, 'gravacao' | 'coldStart' | 'es' | 'pp' | 'max' | 'demandaGravada'> {
  const vazio = { naView: false, classeProposta: null, numOrdens: 0, demanda: null, sigmaD: null, lt: null, sigmaLt: null, z: null, minimoOperacional: null, ssCalculado: null, ppSugerido: null, maxSugerido: null, status: null };
  const classe = propostaDoDia(dados, ix, d).get(s.sku) ?? null;
  const pT = ix.prefTotal.get(s.sku);
  const pL = ix.prefLinhas.get(s.sku);
  const iD = Math.min(idx(d), ix.nDias);
  if (classe === null || !pT || !pL || iD <= 0) return vazio;
  const ini = Math.max(0, iD - F0.janelaDemandaDias);
  const nObs = iD - ini;
  const numOrdens = pL[iD] - pL[ini];
  const demanda = arred((pT[iD] - pT[ini]) / nObs, 4);
  const sigmaD = sigmaJanela(ix, s.sku, d);
  // LT (v_sku_leadtime_estatisticas + v_sku_lt_teorico)
  const iniLt = addDias(d, -F0.janelaLtDias);
  const obs = (ix.obsMotorPorSku.get(s.sku) ?? []).filter((o) => o.t4 < d && o.t4 >= iniLt && (!calib || o.t4 <= JANELAS.calibracaoFim)).map((o) => o.lt);
  const teorico = s.grupo !== null && s.grupo in LT_TEORICO_DU ? LT_TEORICO_DU[s.grupo] : null;
  let ltHist: number | null = null;
  let desvioHist: number | null = null;
  let desvioForn: number | null = null;
  if (obs.length > 0) {
    const forn = fornecedorLt(ix, d, calib);
    desvioForn = forn.desvio;
    if (obs.length >= F0.minObsLtSku) {
      ltHist = arred(media(obs), 2);
      const dp = desvioAmostral(obs);
      desvioHist = dp === null ? null : arred(dp, 2);
    } else {
      ltHist = forn.media;
      desvioHist = forn.desvio;
    }
  }
  const lt = teorico === null ? ltHist : ltHist === null ? teorico : Math.max(teorico, ltHist);
  const sigmaLt = desvioHist ?? desvioForn ?? (teorico ?? F0.ltPadrao) * F0.fatorSigmaLtPadrao;
  // preço do EOQ: cmc (hoje) → [preço de compra real: não extraído] → preço médio de venda 180 d × 0,55
  let preco: number | null = s.cmc !== null && s.cmc > 0 ? s.cmc : null;
  if (preco === null) {
    const iniP = idx(d) - 180;
    const ps = (ix.linhas.get(s.sku) ?? []).filter((l) => l.i >= iniP && l.i < idx(d)).map((l) => l.preco);
    preco = ps.length ? media(ps) * F0.fatorPrecoVenda : null;
  }
  const status: StatusSugestao =
    numOrdens < 2 ? 'AGUARDANDO_SEGUNDA_ORDEM'
    : lt === null ? 'SEM_LEADTIME_DEFINIDO'
    : s.grupo === null ? 'AGUARDANDO_CLASSIFICACAO_GRUPO'
    : preco === null || preco === 0 ? 'SEM_PRECO'
    : 'OK';
  const z = dados.zPorClasse[classe];
  const minimoOperacional = MINIMO_OPERACIONAL_POR_CLASSE[classe];
  const base = { naView: true, classeProposta: classe, numOrdens, demanda, sigmaD, lt, sigmaLt, z, minimoOperacional };
  if (status !== 'OK' || lt === null || preco === null) return { ...base, ssCalculado: null, ppSugerido: null, maxSugerido: null, status };
  const sd = sigmaD ?? demanda * 0.5;
  const sigmaLtD = Math.sqrt(lt * sd ** 2 + demanda ** 2 * sigmaLt ** 2);
  const ss = teto9(z * sigmaLtD);
  const ppCalc = teto9(demanda * lt + z * sigmaLtD);
  const cm = s.f0.custoCapitalPerc / 100;
  const qc = preco > 0 && cm > 0 && demanda > 0 ? teto9(Math.sqrt((2 * (demanda * F0.diasAnoEoq) * s.f0.custoPedido) / (cm * preco))) : 1;
  const minSug = Math.max(ss, minimoOperacional);
  const ppSug = Math.max(ppCalc, minSug + 1);
  return { ...base, ssCalculado: ss, ppSugerido: ppSug, maxSugerido: ppSug + Math.max(qc, 1), status };
}

/** Rola atualizar_parametros_numericos_skus (1×/dia) do início até `ate`, guardando o diagnóstico de cada dia. */
function trajetoriaF0(dados: Dados, sku: string, ate: Data, calib: boolean): TrajetoriaF0 {
  const ix = indice(dados);
  const chave = `${sku}|${calib ? 1 : 0}`;
  let t = ix.trajF0.get(chave);
  if (!t) ix.trajF0.set(chave, (t = { ate: null, estado: ESTADO_COLD_START, demanda: null, dias: new Map() }));
  const s = dados.skus.get(sku);
  const inicio = addDias(INICIO_AQUECIMENTO, F0.diasMinObservados);
  if (!s || ate < inicio) return t;
  let d = t.ate === null ? inicio : addDias(t.ate, 1);
  for (; d <= ate; d = addDias(d, 1)) {
    const sug = sugestaoF0(dados, ix, s, d, calib);
    let gravacao: StatusGravacao = 'fora_da_view';
    if (sug.naView) {
      t.demanda = sug.demanda;
      const a = t.estado;
      const { ssCalculado: ss, ppSugerido: pp, maxSugerido: max } = sug;
      const min = ss === null ? null : Math.max(ss, sug.minimoOperacional ?? 0);
      const cob = max !== null && pp !== null && sug.demanda !== null && sug.demanda > 0 ? Math.ceil((max - pp) / sug.demanda) : null;
      if (ss === null || pp === null || max === null || min === null || cob === null) gravacao = 'sem_mudanca';
      else if (min < 0 || pp < 0 || max < 0 || ss < 0 || max < pp || pp < min || cob <= 0) gravacao = 'bloqueado_validacao';
      else if (a.coldStart) gravacao = 'semeado';
      else if (!(a.max > 0)) gravacao = 'bloqueado_validacao';
      else if (Math.round(pp) === Math.round(a.pp) && Math.round(max) === Math.round(a.max)) gravacao = 'sem_mudanca';
      else if (Math.round(max) > FUSIVEL_PARAM_MULT * Math.round(a.max)) gravacao = 'segurado';
      else gravacao = 'aplicado';
      if ((gravacao === 'semeado' || gravacao === 'aplicado') && ss !== null && pp !== null && max !== null && min !== null) t.estado = { es: ss, pp, max, min, coldStart: false };
    }
    t.dias.set(d, { ...sug, gravacao, coldStart: t.estado.coldStart, es: t.estado.es, pp: t.estado.pp, max: t.estado.max, demandaGravada: t.demanda });
    t.ate = d;
  }
  return t;
}

/** Diagnóstico do F0 no dia d (a sugestão da view e o gravado depois da passada do dia). */
export function diagnosticoF0(dados: Dados, sku: string, d: Data, ctx: { calibracao: boolean }): DiagnosticoF0 {
  const t = trajetoriaF0(dados, sku, d, ctx.calibracao);
  return (
    t.dias.get(d) ?? {
      naView: false, classeProposta: null, numOrdens: 0, demanda: null, sigmaD: null, lt: null, sigmaLt: null, z: null, minimoOperacional: null,
      ssCalculado: null, ppSugerido: null, maxSugerido: null, status: null, gravacao: null, coldStart: true, es: null, pp: null, max: null, demandaGravada: null,
    }
  );
}

function paramsF0(dados: Dados, sku: string, d: Data, calib: boolean): ParamsF0 | SemDecisao {
  const ix = indice(dados);
  const g = ix.grupoDe.get(sku);
  if (g && g.ancora !== sku) return { tipo: 'SEM_DECISAO', motivo: 'MEMBRO_GRUPO_NAO_ANCORA' };
  const diag = diagnosticoF0(dados, sku, d, { calibracao: calib });
  const s = dados.skus.get(sku);
  if (!s) return { tipo: 'SEM_DECISAO', motivo: 'F0_SEM_PARAMETRO' };
  let cobertura: number | null = null;
  if (dados.teto.ativa && !g && !(s.minimoForcado !== null && s.minimoForcado > 0)) {
    const c = efetivaDoDia(dados, ix, d).get(sku);
    const dias = c === 'B' ? dados.teto.diasB : c === 'C' ? dados.teto.diasC : null;
    cobertura = dias !== null && dias > 0 ? dias : null; // '0' → NULL no parse do motor
  }
  // antes do 1º dia do motor (diag sem passada) vale o cold start, como depois dele até a 1ª sugestão OK
  return { tipo: 'F0', pp: diag.pp ?? COLD_START.pp, max: diag.max ?? COLD_START.max, coberturaTetoDias: cobertura, demandaDiariaLinha: diag.demandaGravada };
}

// ── F1–F3 ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Série por dia útil (balde) do SKU — na unidade-base do grupo para a âncora (soma dos membros, mesma unidade). */
function serieDu(ix: Indice, sku: string): Float64Array {
  let s = ix.serieDu.get(sku);
  if (s) return s;
  s = new Float64Array(ix.du.length);
  const g = ix.grupoDe.get(sku);
  for (const m of g ? g.membros : [sku]) {
    const t = ix.totalDia.get(m);
    if (!t) continue;
    for (let i = 0; i < t.length; i++) if (t[i] !== 0 && ix.baldeDoDia[i] >= 0) s[ix.baldeDoDia[i]] += t[i];
  }
  ix.serieDu.set(sku, s);
  return s;
}
/** Nº de baldes (dias úteis) estritamente antes de d. */
function baldesAntes(ix: Indice, d: Data): number {
  const i = idx(d);
  if (i <= 0) return 0;
  return ix.baldeDoDia[Math.min(i, ix.nDias) - 1] + 1;
}

/** Amostra de LT documental (t4 < d): do SKU/grupo se >= 5, senão da Sayerlack toda; null se vazia. Ordenada. */
function amostraLt(dados: Dados, ix: Indice, sku: string, d: Data, calib: boolean): number[] | null {
  const g = ix.grupoDe.get(sku);
  const meus = new Set(g ? g.membros : [sku]);
  const ok = (t4: Data | null): t4 is Data => t4 !== null && t4 < d && (!calib || t4 <= JANELAS.calibracaoFim);
  const proprios: number[] = [];
  const todos: number[] = [];
  for (const it of dados.itensLT) {
    if (it.aberto || !ok(it.t4)) continue;
    todos.push(it.ltDu);
    if (meus.has(it.sku)) proprios.push(it.ltDu);
  }
  const a = proprios.length >= MIN_RECEBIMENTOS_SKU_LT ? proprios : todos;
  return a.length ? a.sort((x, y) => x - y) : null;
}

type Grade = ParamsF0 | SemDecisao | { tipo: 'GRADE'; valores: number[] } | { tipo: 'GRADE_BETA'; porBeta: number[][] };

function gradeF1(serie: Float64Array, n: number, lts: number[]): number[] {
  const ini = Math.max(0, n - F1_JANELA_DU);
  const janela = serie.subarray(ini, n);
  const dBar = media(janela);
  const sd = desvioAmostral(janela) ?? 0;
  const ltBar = media(lts);
  const sLt = desvioAmostral(lts) ?? 0;
  const H = ltBar + 1;
  const mu = H * dBar;
  const dp = Math.sqrt(H * sd * sd + dBar * dBar * sLt * sLt);
  return GRADE_QUANTIS.map((q) => mu + normalInversa(q) * dp);
}

function gradeF3(serie: Float64Array, n: number, lts: number[], janelaDias: number): number[] | null {
  const H = teto9(media(lts)) + 1;
  const ini = Math.max(0, n - janelaDias);
  const len = n - ini;
  if (len < H) return null;
  const somas = new Float64Array(len - H + 1);
  let acc = 0;
  for (let i = ini; i < ini + H; i++) acc += serie[i];
  somas[0] = acc;
  for (let k = 1; k < somas.length; k++) {
    acc += serie[ini + H - 1 + k] - serie[ini + k - 1];
    somas[k] = acc;
  }
  somas.sort();
  return GRADE_QUANTIS.map((q) => quantilTipo7(somas, q));
}

/** p̂ do TSB depois de processar os baldes [0, n): inicializa nos primeiros 63 du; depois p += β(I − p). */
function pTsb(serie: Float64Array, n: number, beta: number): number {
  const nIni = Math.min(TSB.diasInicializacao, n);
  let pos = 0;
  for (let i = 0; i < nIni; i++) if (serie[i] > 0) pos++;
  let p = pos / nIni;
  for (let i = nIni; i < n; i++) p += beta * ((serie[i] > 0 ? 1 : 0) - p);
  return p;
}

function aleatoriosF2(ix: Indice, sku: string) {
  let a = ix.aleatoriosF2.get(sku);
  if (a) return a;
  const K = TSB.trajetorias;
  const hMax = ix.maxLtDu + 1;
  const L = new Float64Array(K);
  const B = new Float64Array(K * hMax);
  const R = new Float64Array(K * hMax);
  for (let k = 0; k < K; k++) {
    L[k] = uniformePar(sku, 'F2', k, 'L')[0];
    for (let j = 0; j < hMax; j++) {
      const [b, r] = uniformePar(sku, 'F2', k, j);
      B[k * hMax + j] = b;
      R[k * hMax + j] = r;
    }
  }
  ix.aleatoriosF2.set(sku, (a = { L, B, R, hMax }));
  return a;
}

/** 2.000 trajetórias de LT+1 du: Bernoulli(p̂ TSB) × tamanho sorteado do histórico de dias positivos. Grade por β. */
function gradeF2(ix: Indice, sku: string, serie: Float64Array, n: number, lts: number[]): number[][] {
  const tamanhos: number[] = [];
  for (let i = 0; i < n; i++) if (serie[i] > 0) tamanhos.push(serie[i]);
  tamanhos.sort((x, y) => x - y);
  const ps = BETAS.map((b) => pTsb(serie, n, b));
  const { L, B, R, hMax } = aleatoriosF2(ix, sku);
  const K = TSB.trajetorias;
  const tot = BETAS.map(() => new Float64Array(K));
  const m = tamanhos.length;
  for (let k = 0; k < K; k++) {
    const H = Math.min(lts[Math.floor(L[k] * lts.length)] + 1, hMax);
    let t0 = 0;
    let t1 = 0;
    let t2 = 0;
    const base = k * hMax;
    for (let j = 0; j < H; j++) {
      const u = B[base + j];
      if (u >= ps[0] && u >= ps[1] && u >= ps[2]) continue;
      const z = tamanhos[Math.floor(R[base + j] * m)];
      if (u < ps[0]) t0 += z;
      if (u < ps[1]) t1 += z;
      if (u < ps[2]) t2 += z;
    }
    tot[0][k] = t0;
    tot[1][k] = t1;
    tot[2][k] = t2;
  }
  return tot.map((a) => {
    a.sort();
    return GRADE_QUANTIS.map((q) => quantilTipo7(a, q));
  });
}

function gradeNoDia(f: Formula, dados: Dados, sku: string, d: Data, janelaDias: number | undefined, calib: boolean): Grade {
  const ix = indice(dados);
  const g = ix.grupoDe.get(sku);
  if (g && g.ancora !== sku) return { tipo: 'SEM_DECISAO', motivo: 'MEMBRO_GRUPO_NAO_ANCORA' };
  if (f === 'F0') return paramsF0(dados, sku, d, calib);
  if (!ehDiaUtil(d)) throw new Error(`DIA_NAO_UTIL:${d}`);
  const serie = serieDu(ix, sku);
  const n = baldesAntes(ix, d);
  let positivos = 0;
  for (let i = 0; i < n && positivos < 2; i++) if (serie[i] > 0) positivos++;
  const lts = positivos < 2 ? null : amostraLt(dados, ix, sku, d, calib);
  if (lts === null) return paramsF0(dados, sku, d, calib);
  if (f === 'F1') return { tipo: 'GRADE', valores: gradeF1(serie, n, lts) };
  if (f === 'F3') {
    if (janelaDias === undefined) throw new Error('F3_SEM_JANELA');
    const v = gradeF3(serie, n, lts, janelaDias);
    return v === null ? paramsF0(dados, sku, d, calib) : { tipo: 'GRADE', valores: v };
  }
  return { tipo: 'GRADE_BETA', porBeta: gradeF2(ix, sku, serie, n, lts) };
}

/** Classe que escolhe o quantil: classe efetiva no INÍCIO da janela medida (R2); sem classe → C (R13). */
function classeDoQuantil(dados: Dados, sku: string, calib: boolean): Classe {
  const ix = indice(dados);
  const g = ix.grupoDe.get(sku);
  return efetivaDoDia(dados, ix, calib ? JANELAS.calibracaoIni : JANELAS.avaliacaoIni).get(g ? g.ancora : sku) ?? 'C';
}

function resolver(grade: Grade, p: ParamsFormula, classe: Classe): ParamsDia {
  if (grade.tipo === 'F0' || grade.tipo === 'SEM_DECISAO') return grade;
  const q = p.quantil[classe];
  const iq = GRADE_QUANTIS.findIndex((x) => Math.abs(x - q) < 1e-12);
  if (iq < 0) throw new Error(`QUANTIL_FORA_DA_GRADE:${q}`);
  let v: number;
  if (grade.tipo === 'GRADE') v = grade.valores[iq];
  else {
    if (p.beta === undefined) throw new Error('F2_SEM_BETA');
    v = grade.porBeta[BETAS.indexOf(p.beta)][iq];
  }
  return { tipo: 'S', s: Math.max(0, teto9(v)) };
}

/** Parâmetros da fórmula no dia d do SKU, vendo só dados < d (e, com ctx.calibracao, só LT com t4 <= fim da calibração). */
export function parametrosNoDia(f: Formula, dados: Dados, sku: string, d: Data, p: ParamsFormula, ctx: { calibracao: boolean }): ParamsDia {
  const grade = gradeNoDia(f, dados, sku, d, p.janelaDias, ctx.calibracao);
  return resolver(grade, p, classeDoQuantil(dados, sku, ctx.calibracao));
}

// ── preComputar + cache em disco ──────────────────────────────────────────────────────────────────────────────────
const PASTA = dirname(fileURLToPath(import.meta.url));
const DATAS_TS = join(PASTA, '../../src/lib/reposicao/orcamento-compra/datas.ts');

/** Fontes .ts do replay que entram no hash do código (sem os testes) + o datas.ts compartilhado. Ordenadas. */
export function fontesDoCodigo(): string[] {
  const fs = readdirSync(PASTA).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort().map((f) => join(PASTA, f));
  return [...fs, DATAS_TS];
}
export function hashCodigo(): string {
  const h = createHash('sha256');
  for (const f of fontesDoCodigo()) {
    h.update(`${f.slice(PASTA.length)}\u0000`);
    h.update(readFileSync(f));
    h.update('\u0000');
  }
  return h.digest('hex');
}

const CALENDARIO = { regra: 'seg-sex sem feriados; fim de semana no dia útil anterior', inicio: INICIO_AQUECIMENTO, janelas: JANELAS };
const PRECISAO_CHAVE = { trajetorias: TSB.trajetorias, grade: GRADE_QUANTIS, alfa: TSB.alfa, betas: TSB.betas };

export interface EntradaChave {
  hashDados: string;
  dataExtracao: Data;
  hashCodigo: string;
  formula: Formula;
  janelaDias: number | null;
  ctx: { calibracao: boolean; dias: [Data, Data]; skus: string[] };
}
/** sha256(hashDados, dataExtracao, hashCodigo, calendário, precisão, f, janela, ctx). O quantil e o β NÃO entram: o disco guarda a GRADE (todos os quantis e os 3 β); resolver é barato. */
export function chaveCache(e: EntradaChave): string {
  return createHash('sha256')
    .update(JSON.stringify({ ...e, calendario: CALENDARIO, precisao: PRECISAO_CHAVE, ctx: { ...e.ctx, skus: [...e.ctx.skus].sort() } }))
    .digest('hex');
}

export interface OpcoesPreComputar {
  /** null = sem disco; padrão $REPLAY_DADOS/cache (nunca no repositório). */
  cacheDir?: string | null;
  /** Para testes: substitui o hash dos fontes. */
  hashCodigo?: string;
}
const pastaCachePadrao = () => join(process.env.REPLAY_DADOS ?? join(homedir(), '.cache/afiacao/reposicao-replay'), 'cache');

const gradesMemo = new WeakMap<Dados, Map<string, Map<string, Grade>>>();

/** Dias úteis padrão do contexto: do início do aquecimento ao fim da janela (calibração ou avaliação). */
export function diasDoContexto(ctx: CtxFormula): [Data, Data] {
  return ctx.dias ?? [INICIO_AQUECIMENTO, ctx.calibracao ? JANELAS.calibracaoFim : JANELAS.avaliacaoFim];
}

export function preComputarComOrigem(
  f: Formula,
  dados: Dados,
  p: ParamsFormula,
  ctx: CtxFormula,
  opcoes: OpcoesPreComputar = {},
): { mapa: Map<string, ParamsDia>; origem: 'memoria' | 'cache' | 'calculado'; chave: string } {
  const dias = diasDoContexto(ctx);
  const skus = ctx.skus ?? [...coorteTodosAtivos(dados).populacao].sort();
  const janelaDias = f === 'F3' ? (p.janelaDias ?? null) : null;
  if (f === 'F3' && janelaDias === null) throw new Error('F3_SEM_JANELA');
  const chave = chaveCache({
    hashDados: dados.hashDados, dataExtracao: dados.dataExtracao, hashCodigo: opcoes.hashCodigo ?? hashCodigo(), formula: f, janelaDias,
    ctx: { calibracao: ctx.calibracao, dias, skus },
  });
  let porChave = gradesMemo.get(dados);
  if (!porChave) gradesMemo.set(dados, (porChave = new Map()));
  let grades = porChave.get(chave);
  let origem: 'memoria' | 'cache' | 'calculado' = 'memoria';
  const dir = opcoes.cacheDir === undefined ? pastaCachePadrao() : opcoes.cacheDir;
  const arq = dir === null ? null : join(dir, `grades-${f}-${chave}.json`);
  if (!grades && arq !== null && existsSync(arq)) {
    const j = JSON.parse(readFileSync(arq, 'utf8')) as { chave: string; entradas: [string, Grade][] };
    if (j.chave === chave) {
      grades = new Map(j.entradas);
      origem = 'cache';
    }
  }
  if (!grades) {
    origem = 'calculado';
    grades = new Map();
    const ix = indice(dados);
    const dus = ix.du.filter((d) => d >= dias[0] && d <= dias[1]);
    for (const s of skus) {
      if (!dados.skus.has(s)) throw new Error(`SKU_FORA_DOS_DADOS:${s}`);
      for (const d of dus) grades.set(`${s}|${d}`, gradeNoDia(f, dados, s, d, janelaDias ?? undefined, ctx.calibracao));
      ix.aleatoriosF2.delete(s); // ~1 MB por SKU: não acumular (M2 8 GB)
    }
    if (arq !== null && dir !== null) {
      mkdirSync(dir, { recursive: true });
      const tmp = `${arq}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ chave, formula: f, entradas: [...grades] }));
      renameSync(tmp, arq);
    }
  }
  porChave.set(chave, grades);
  const mapa = new Map<string, ParamsDia>();
  const classes = new Map<string, Classe>();
  for (const [k, g] of grades) {
    const s = k.slice(0, k.indexOf('|'));
    let c = classes.get(s);
    if (!c) classes.set(s, (c = classeDoQuantil(dados, s, ctx.calibracao)));
    mapa.set(k, resolver(g, p, c));
  }
  return { mapa, origem, chave };
}

/** Parâmetros de cada `${sku}|${dia útil}` do contexto (cache em disco: ver `chaveCache`). */
export function preComputar(f: Formula, dados: Dados, p: ParamsFormula, ctx: CtxFormula): Map<string, ParamsDia> {
  return preComputarComOrigem(f, dados, p, ctx).mapa;
}

// ── paridade do F0 contra o gravado hoje (R14: ES, PP e máximo; a quantidade comprada fica na Task 6) ─────────────────
/** |calculado − hoje| <= max(1, 5% de hoje). Ausente de qualquer lado = fora. */
export function dentroDaTolerancia(hoje: number | null, calculado: number | null): boolean {
  if (hoje === null || calculado === null) return false;
  return Math.abs(calculado - hoje) <= Math.max(1, 0.05 * Math.abs(hoje));
}

export type CampoParidade = 'es' | 'pp' | 'max';
export interface DivergenciaParidade {
  sku: string;
  campo: CampoParidade;
  hoje: number;
  calculado: number | null;
  /** |Δ| × cmc de hoje (R$); null sem cmc. Absoluto: só em $REPLAY_DADOS. */
  impactoValor: number | null;
  causa: 'F0_COLD_START' | 'FUSIVEL_SEGURADO' | 'CONGELADO_FORA_DA_VIEW' | 'NUMERICA';
}
export interface RelatorioParidade {
  data: Data;
  populacao: number;
  excluidos: { sku: string; motivo: string }[];
  comparados: Record<CampoParidade, number>;
  dentro: Record<CampoParidade, number>;
  /** SKUs com os 3 campos comparáveis e todos dentro da tolerância. */
  skusTodosDentro: { n: number; de: number };
  valorMaximoTotal: number;
  /** Σ |Δmáximo| × cmc nas divergências de máximo. */
  valorDeltaMaximoDivergente: number;
  /** Σ máximo_hoje × cmc dos SKUs com qualquer divergência. */
  valorMaximoDosDivergentes: number;
  gravacaoNoDia: Record<string, number>;
  divergencias: DivergenciaParidade[];
}

/** Recalcula o F0 para o dia da extração (dados < extração) e compara com `sku.hoje`. Padrão: a coorte. */
export function paridadeF0(dados: Dados, skus: Iterable<string> = coorte(dados).populacao): RelatorioParidade {
  const d = dados.dataExtracao;
  const ix = indice(dados);
  const lista = [...skus].sort();
  const rel: RelatorioParidade = {
    data: d, populacao: lista.length, excluidos: [], comparados: { es: 0, pp: 0, max: 0 }, dentro: { es: 0, pp: 0, max: 0 },
    skusTodosDentro: { n: 0, de: 0 }, valorMaximoTotal: 0, valorDeltaMaximoDivergente: 0, valorMaximoDosDivergentes: 0, gravacaoNoDia: {}, divergencias: [],
  };
  for (const sku of lista) {
    const s = dados.skus.get(sku);
    if (!s) {
      rel.excluidos.push({ sku, motivo: 'FORA_DOS_DADOS' });
      continue;
    }
    const g = ix.grupoDe.get(sku);
    if (g && g.ancora !== sku) {
      rel.excluidos.push({ sku, motivo: 'MEMBRO_GRUPO_NAO_ANCORA' });
      continue;
    }
    const diag = diagnosticoF0(dados, sku, d, { calibracao: false });
    const t = trajetoriaF0(dados, sku, d, false);
    rel.gravacaoNoDia[diag.gravacao ?? 'sem_passada'] = (rel.gravacaoNoDia[diag.gravacao ?? 'sem_passada'] ?? 0) + 1;
    if (s.hoje.max !== null && s.cmc !== null) rel.valorMaximoTotal += s.hoje.max * s.cmc;
    const segurado = [...t.dias.values()].some((x) => x.gravacao === 'segurado');
    let todos = 0;
    let algumFora = false;
    for (const campo of ['es', 'pp', 'max'] as const) {
      const hoje = s.hoje[campo];
      if (hoje === null) continue;
      rel.comparados[campo]++;
      const calc = diag[campo];
      if (dentroDaTolerancia(hoje, calc)) {
        rel.dentro[campo]++;
        todos++;
        continue;
      }
      algumFora = true;
      const impacto = calc === null || s.cmc === null ? null : Math.abs(calc - hoje) * s.cmc;
      if (campo === 'max' && impacto !== null) rel.valorDeltaMaximoDivergente += impacto;
      rel.divergencias.push({
        sku, campo, hoje, calculado: calc, impactoValor: impacto,
        causa: diag.coldStart ? 'F0_COLD_START' : segurado ? 'FUSIVEL_SEGURADO' : !diag.naView ? 'CONGELADO_FORA_DA_VIEW' : 'NUMERICA',
      });
    }
    if (s.hoje.es !== null && s.hoje.pp !== null && s.hoje.max !== null) {
      rel.skusTodosDentro.de++;
      if (todos === 3) rel.skusTodosDentro.n++;
    }
    if (algumFora && s.hoje.max !== null && s.cmc !== null) rel.valorMaximoDosDivergentes += s.hoje.max * s.cmc;
  }
  return rel;
}

/** Grava o relatório de paridade (com R$ absolutos) em `dir` — use $REPLAY_DADOS, NUNCA o repositório. */
export function gravarParidade(rel: RelatorioParidade, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const arq = join(dir, 'paridade-f0.json');
  writeFileSync(arq, JSON.stringify(rel, null, 2));
  return arq;
}
