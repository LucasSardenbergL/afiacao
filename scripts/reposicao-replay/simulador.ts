// Simulador do replay TSB (spec §5.3, §5.4, §5.5, §5.7 e §5.9 "Lead time" e "Obrigações por linha").
//
// Uma chamada = uma fórmula × uma replicação × um cenário (LT, falta, estado inicial) × uma janela medida. O estado
// evolui do INÍCIO DO AQUECIMENTO (estoque de abertura de `estoqueInicial`) até o fim da janela; só as linhas com data
// dentro da janela são MEDIDAS (as anteriores consomem estoque e geram obrigações, mas não entram nas somas).
//
// Ordem de cada dia corrido (fim de semana incluso — venda de sábado existe; compra só em dia útil):
//   1. chegadas (compras simuladas e as compras abertas no início);
//   2. obrigações FIFO por SKU (saldo por linha; entrega tardia; NÃO reentram no denominador);
//   3. linhas do dia em ordem de (data, linhaId): integral = sucesso; senão UMA falha — a parte disponível é entregue e
//      o resto segue o desfecho (espera → obrigação; cancelamento; misto = uniforme(rep,'falta',linhaId) em 60% espera,
//      30% compra emergencial (sai do sistema sem backlog) e 10% cancelamento — config.CENARIOS_FALTA.misto);
//   4. compra com `decidirCompra`, só em dia útil, sobre posição = físico + abertas − obrigações.
//
// DECISÕES DOCUMENTADAS (controlador, Task 6):
//  · ltDu = 0 chega no PRÓXIMO dia útil depois do pedido (LT efetivo mínimo de 1 du).
//  · Compras abertas no início = recebimentos físicos (R9) de (sku, t4) cujo documento de LT tem t1 < início <= t4. Elas
//    entram como chegadas programadas e contam na posição. Os demais recebimentos históricos são SUBSTITUÍDOS pelas
//    compras simuladas. (No dado real o 1º recebimento é de 2026-01-28: o conjunto é vazio — reportado.)
//  · Células (R2): classe efetiva do SKU no INÍCIO da janela medida (sem classe → C, como R13); `*_alt` = coorte.alterados;
//    `total` = todas as linhas medidas.
//  · Grupo de embalagem: a âncora decide na unidade-base do grupo (posição = soma dos membros simulados, todos na mesma
//    unidade de estoque — formulas.ts barra unidade mista) e compra embalagens da âncora: ceil(necessidade / conv), que
//    chegam como embalagens × conv na unidade de estoque. Sem troca para o galão (o replay não tem o preço-app histórico
//    que decide a troca — limitação declarada). O galão (SEM_DECISAO) não decide; o ATENDIMENTO é por SKU.
//  · Substituição (`substituicao = true`) é outra coisa: só para a métrica "com substituição". Uma linha que o próprio
//    estoque não cobre pode ser completada pelo estoque de um equivalente do grupo, se ele cobrir TODO o restante e o
//    restante for um número inteiro de embalagens do equivalente (unidades Omie por embalagem conhecidas); o estoque do
//    equivalente é BAIXADO (o mesmo galão não salva duas linhas). Só no passo 3 (não nas obrigações).
//  · Margem cancelada = valor − cmcLinha × quantidade; cmcLinha null ⇒ margem null: fica FORA de `cancelada.margem` e é
//    contada em `canceladaSemCmc` (nunca 0 fabricado); semana só com canceladas sem cmc ⇒ margem null. Capital: na
//    CALIBRAÇÃO, o último cmcLinha <= fim da calibração (o cmc de hoje seria futuro); na AVALIAÇÃO, o CMC de hoje como
//    numerário constante. SKU sem CMC fica fora do capital e listado em `skusSemCmc` (o mesmo conjunto em todas as fórmulas).
//  · Linha com quantidade <= 0 (4 no dado real, todas q = 0 e valor 0) não é demanda: ignorada e contada.
//  · Fechamento verificado a cada chamada (fail-closed): por SKU, demanda medida = imediata + tardia + emergencial +
//    cancelada + backlog terminal (unidades); estoque inicial + recebido − entregue = final. Violação lança.
import { diffDias, ehDiaUtil, addDias } from '../../src/lib/reposicao/orcamento-compra/datas';
import { itensLtPermitidos, ltRealizado, uniforme, type CenarioLT } from './aleatorio';
import { classeEfetiva } from './classe';
import { CENARIOS_FALTA, INICIO_AQUECIMENTO, JANELAS } from './config';
import { grupoDeEmbalagem, type Formula, type ParamsDia } from './formulas';
import { coorte } from './parados';
import { estoqueInicial, type CenarioInicial } from './reconstrucao';
import type { Classe, Dados, Data, ItemLT, Sku } from './tipos';

// ── tipos públicos ─────────────────────────────────────────────────────────────────────────────────────────────
export type Celula = Classe | 'A_alt' | 'B_alt' | 'C_alt' | 'total';
export const CELULAS: readonly Celula[] = ['A', 'B', 'C', 'A_alt', 'B_alt', 'C_alt', 'total'];
export type Falta = 'espera' | 'cancelamento' | 'misto';

export interface SomasCelula {
  demandadas: number[];
  integrais: number[];
  unidDem: number[];
  /** Unidades entregues NO DIA da linha (imediata). */
  unidAt: number[];
  valorDem: number[];
  valorAt: number[];
}
export interface SomasSemanais {
  /** 1º dia de cada bloco de 7 dias corridos a partir do início da janela (o último pode ser parcial). */
  semanas: Data[];
  porCelula: Record<Celula, SomasCelula>;
  /** Σ (estoque físico de fim de dia × CMC) por dia corrido: ponderado pelos dias em que cada saldo permanece. */
  estoqueCmcDias: number[];
  diasCorridos: number[];
  /** Valor (R$ da linha, pró-rata) entregue: imediata no dia; tardia por obrigação; emergencial por compra fora. */
  entregue: { imediata: number[]; tardia: number[]; emergencial: number[] };
  /**
   * `margem` só das linhas com cmcLinha; as sem cmc vão para `canceladaSemCmc`. Semana em que TODAS as canceladas são sem
   * cmc ⇒ null (ausente ≠ zero). Semana mista ⇒ margem PARCIAL: razão margem/valor exige excluir `canceladaSemCmc.valor`.
   */
  cancelada: { valor: number[]; margem: (number | null)[] };
  canceladaSemCmc: { linhas: number[]; valor: number[] };
  /** Σ valor entregue tardiamente × dias corridos de atraso, linha a linha, na semana da entrega. */
  valorDiasAtraso: number[];
  terminal: { estoqueCmc: number; abertasCmc: number; backlogValor: number; backlogDiasAtraso: number };
  /** Unidades de estoque no horizonte inteiro (do início do aquecimento ao fim da janela), todos os SKUs simulados. */
  balanco: { inicial: number; recebido: number; entregue: number; final: number };
  skusSemCmc: string[];
  excluidos: { sku: string; motivo: 'FORA_DOS_DADOS' | 'SEM_ESTOQUE_INICIAL' }[];
  linhasIgnoradas: number;
  /** Só com `rastro: true` (testes/diagnóstico): os pedidos simulados, qtd na unidade de estoque. */
  pedidos?: { dia: Data; sku: string; qtd: number; chegada: Data | null }[];
  /** Só com `rastro: true`: o desfecho de cada linha que falhou (medida ou não). */
  desfechos?: { linhaId: string; desfecho: 'espera' | 'cancelamento' | 'emergencial' }[];
}

export interface EntradaSimulacao {
  formula: Formula;
  params: Map<string, ParamsDia>;
  rep: number;
  lt: CenarioLT;
  falta: Falta;
  inicial: CenarioInicial;
  janela: [Data, Data];
  dados: Dados;
  substituicao?: boolean;
  /** Amostra de LT; padrão: `itensLtPermitidos(dados.itensLT, janela termina na calibração)`. */
  itensLT?: readonly ItemLT[];
  rastro?: boolean;
  /**
   * SKUs "alterados" que definem as células *_alt — devem ser os MESMOS que trocam de fórmula no mapa (revisão final I2).
   * Padrão: coorte(dados).alterados.
   */
  alterados?: ReadonlySet<string>;
}

// ── decisão de compra (db/embalagem-motor-rpc.sql ~L400-520) ────────────────────────────────────────────────────
/** Arredonda a 9 casas antes de ceil/floor (o PG calcula em numeric exato; o double erra na 16ª casa). */
const r9 = (x: number): number => Math.round(x * 1e9) / 1e9;
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/**
 * Quantidade da compra na unidade do MOTOR (unidades Omie; no grupo, embalagens da âncora). 0 = não compra.
 *  · F0: gatilho posição <= PP; necessidade = máximo − posição; teto B/C só sem grupo e sem mínimo forçado:
 *    cap = max(floor(dias × demanda da linha − posição), max(0, ceil(PP − posição))), e só com demanda da linha > 0.
 *  · S (F1–F3): gatilho posição < S; necessidade = S − posição.
 *  · Em ambas, só com necessidade > 0 (o gate `qtde_sugerida > 0`): mínimo forçado como piso ANTES de dividir pelo conv
 *    (helper aplicarMinimoForcado); ceil; e, só SEM grupo, o múltiplo do portal: max(1, ceil(q / múltiplo)) × múltiplo.
 */
export function decidirCompra(p: ParamsDia, posicao: number, sku: Sku, grupo: { conv: number } | null = null): number {
  if (p.tipo === 'SEM_DECISAO') return 0;
  if (!Number.isFinite(posicao)) throw new Error(`POSICAO_INVALIDA:${sku.sku}`);
  const minF = sku.minimoForcado !== null && Number.isFinite(sku.minimoForcado) && sku.minimoForcado > 0 ? sku.minimoForcado : null;
  let necessidade: number;
  let cap: number | null = null;
  if (p.tipo === 'F0') {
    if (!(posicao <= p.pp)) return 0;
    necessidade = p.max - posicao;
    const dem = p.demandaDiariaLinha ?? 0;
    if (grupo === null && minF === null && p.coberturaTetoDias !== null && dem > 0) {
      cap = Math.max(Math.floor(r9(p.coberturaTetoDias * dem - posicao)), Math.max(0, Math.ceil(r9(p.pp - posicao))));
    }
  } else {
    if (!(posicao < p.s)) return 0;
    necessidade = p.s - posicao;
  }
  if (!(r9(necessidade) > 0)) return 0;
  const base = minF !== null ? Math.max(necessidade, minF) : cap !== null ? Math.min(necessidade, cap) : necessidade;
  const conv = grupo === null ? 1 : grupo.conv;
  if (!(conv > 0)) throw new Error(`CONV_INVALIDO:${sku.sku}`);
  let qtd = Math.ceil(r9(base / conv));
  if (qtd <= 0) return 0;
  if (grupo === null && sku.multiplo !== null && sku.multiplo > 0) qtd = r6(Math.max(1, Math.ceil(r6(qtd / sku.multiplo))) * sku.multiplo);
  return qtd;
}

/**
 * Unidades Omie por embalagem (conv do motor, CTE `equiv`) do SKU no seu grupo: as unidades cadastradas se o grupo INTEIRO
 * as tem (> 0, finitas) e u/fator_para_base é o mesmo em todos os membros; senão o próprio fator_para_base. null = fora de grupo.
 */
export function convDoGrupo(dados: Pick<Dados, 'equivalencias'>, sku: string): number | null {
  const eqs = dados.equivalencias ?? [];
  const meu = eqs.find((e) => e.sku === sku);
  if (!meu) return null;
  const membros = new Map<string, { fpb: number; u: number | null }>();
  for (const e of eqs) if (e.grupoId === meu.grupoId && !membros.has(e.sku)) membros.set(e.sku, { fpb: e.fatorParaBaseSku, u: e.unidadesOmieSku });
  const ms = [...membros.values()];
  const ok = ms.every((m) => m.u !== null && Number.isFinite(m.u) && m.u > 0 && m.u < 1e9 && m.fpb > 0);
  const razoes = ok ? ms.map((m) => m.u! / m.fpb) : [];
  const coerente = ok && Math.max(...razoes) - Math.min(...razoes) <= 1e-9 * Math.max(...razoes);
  const m = membros.get(sku)!;
  return coerente ? m.u! : m.fpb;
}

// ── plano (pré-computado por dados × SKUs × janela × estado inicial; reaproveitado entre replicações) ─────────────
const EPS = 1e-9;
const NC = CELULAS.length; // 7: A B C A_alt B_alt C_alt total
const CEL_TOTAL = 6;

interface Plano {
  skus: string[];
  skuObj: Sku[];
  idxSku: Map<string, number>;
  nDias: number;
  iJanela: number;
  dias: Data[];
  util: Uint8Array;
  /** Nº de dias úteis em [0, i]. */
  cntDu: Int32Array;
  /** Índice (dia corrido) do k-ésimo dia útil do horizonte (k a partir de 0). */
  duPos: Int32Array;
  semana: Int32Array;
  semanas: Data[];
  diasPorSemana: number[];
  linIni: Int32Array;
  linSku: Int32Array;
  linQtd: Float64Array;
  linVu: Float64Array;
  linCmc: Float64Array;
  linId: string[];
  linDia: Int32Array;
  linCel: Int8Array;
  linAlt: Int8Array;
  linMedida: Uint8Array;
  offFila: Int32Array;
  cmc: Float64Array;
  skusSemCmc: string[];
  inicial: Float64Array;
  chegIni: { i: number; s: number; q: number }[];
  /** Por SKU: membros simulados do grupo (inclui a âncora) quando o SKU é ÂNCORA; null fora disso. */
  membros: (Int32Array | null)[];
  /** Por SKU âncora: { conv }; null fora de grupo. */
  grupo: ({ conv: number } | null)[];
  ehMembroNaoAncora: Uint8Array;
  /** Por SKU: equivalentes simulados para substituição (u = unidades Omie por embalagem do equivalente). */
  equivs: { j: number; u: number }[][];
  excluidos: SomasSemanais['excluidos'];
  linhasIgnoradas: number;
  itens: readonly ItemLT[];
}

const memoPlanos = new WeakMap<Dados, Map<string, Plano>>();
const memoSkusDoMapa = new WeakMap<Map<string, ParamsDia>, string[]>();
const memoClasse = new WeakMap<Dados, Map<Data, Map<string, Classe>>>();
const memoAlterados = new WeakMap<Dados, Set<string>>();
const memoItens = new WeakMap<Dados, Map<string, ItemLT[]>>();

function skusDoMapa(params: Map<string, ParamsDia>): string[] {
  let s = memoSkusDoMapa.get(params);
  if (!s) {
    const conj = new Set<string>();
    for (const k of params.keys()) conj.add(k.slice(0, k.indexOf('|')));
    memoSkusDoMapa.set(params, (s = [...conj].sort()));
  }
  return s;
}
function classeNoDia(dados: Dados, d: Data): Map<string, Classe> {
  let m = memoClasse.get(dados);
  if (!m) memoClasse.set(dados, (m = new Map()));
  let c = m.get(d);
  if (!c) m.set(d, (c = classeEfetiva(dados, d)));
  return c;
}
function alterados(dados: Dados): Set<string> {
  let a = memoAlterados.get(dados);
  if (!a) memoAlterados.set(dados, (a = coorte(dados).alterados));
  return a;
}
function itensPadrao(dados: Dados, calibracao: boolean): ItemLT[] {
  let m = memoItens.get(dados);
  if (!m) memoItens.set(dados, (m = new Map()));
  const k = calibracao ? 'c' : 'a';
  let it = m.get(k);
  if (!it) m.set(k, (it = itensLtPermitidos(dados.itensLT, calibracao, dados.dataExtracao)));
  return it;
}

function montarPlano(
  dados: Dados,
  skusParams: string[],
  janela: [Data, Data],
  inicial: CenarioInicial,
  itens: readonly ItemLT[],
  altPassado: ReadonlySet<string> | undefined,
): Plano {
  if (!(janela[0] >= INICIO_AQUECIMENTO && janela[0] <= janela[1])) throw new Error(`JANELA_INVALIDA:${janela.join('..')}`);
  const ini = estoqueInicial(dados, inicial);
  const excluidos: Plano['excluidos'] = [];
  const skus: string[] = [];
  for (const s of skusParams) {
    if (!dados.skus.has(s)) excluidos.push({ sku: s, motivo: 'FORA_DOS_DADOS' });
    else if (!ini.has(s)) excluidos.push({ sku: s, motivo: 'SEM_ESTOQUE_INICIAL' });
    else skus.push(s);
  }
  const nSku = skus.length;
  const idxSku = new Map(skus.map((s, i) => [s, i]));
  const skuObj = skus.map((s) => dados.skus.get(s)!);
  // calendário do horizonte
  const nDias = diffDias(INICIO_AQUECIMENTO, janela[1]) + 1;
  const iJanela = diffDias(INICIO_AQUECIMENTO, janela[0]);
  const dias: Data[] = new Array(nDias);
  const util = new Uint8Array(nDias);
  const cntDu = new Int32Array(nDias);
  const duLista: number[] = [];
  const semana = new Int32Array(nDias).fill(-1);
  const semanas: Data[] = [];
  const diasPorSemana: number[] = [];
  for (let i = 0; i < nDias; i++) {
    const d = addDias(INICIO_AQUECIMENTO, i);
    dias[i] = d;
    if (ehDiaUtil(d)) {
      util[i] = 1;
      duLista.push(i);
    }
    cntDu[i] = duLista.length;
    if (i >= iJanela) {
      const w = Math.floor((i - iJanela) / 7);
      semana[i] = w;
      if (w === semanas.length) {
        semanas.push(d);
        diasPorSemana.push(0);
      }
      diasPorSemana[w]++;
    }
  }
  // linhas
  const classe = classeNoDia(dados, janela[0]);
  const alt = altPassado ?? alterados(dados);
  let linhasIgnoradas = 0;
  const vs = dados.vendas
    .filter((v) => {
      if (!v.noEscopo || !idxSku.has(v.sku) || v.data < INICIO_AQUECIMENTO || v.data > janela[1]) return false;
      if (!(v.quantidade > 0)) {
        linhasIgnoradas++;
        return false;
      }
      return true;
    })
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.linhaId < b.linhaId ? -1 : a.linhaId > b.linhaId ? 1 : 0));
  const nL = vs.length;
  const linIni = new Int32Array(nDias + 1);
  const linSku = new Int32Array(nL);
  const linQtd = new Float64Array(nL);
  const linVu = new Float64Array(nL);
  const linCmc = new Float64Array(nL);
  const linId: string[] = new Array(nL);
  const linDia = new Int32Array(nL);
  const linCel = new Int8Array(nL);
  const linAlt = new Int8Array(nL);
  const linMedida = new Uint8Array(nL);
  const porSku = new Int32Array(nSku);
  const ORD: Record<Classe, number> = { A: 0, B: 1, C: 2 };
  for (let L = 0; L < nL; L++) {
    const v = vs[L];
    const s = idxSku.get(v.sku)!;
    const i = diffDias(INICIO_AQUECIMENTO, v.data);
    linSku[L] = s;
    linQtd[L] = v.quantidade;
    linVu[L] = v.valor / v.quantidade;
    linCmc[L] = v.cmcLinha === null ? NaN : v.cmcLinha;
    linId[L] = v.linhaId;
    linDia[L] = i;
    const c = ORD[classe.get(v.sku) ?? 'C'];
    linCel[L] = c;
    linAlt[L] = alt.has(v.sku) ? 3 + c : -1;
    linMedida[L] = i >= iJanela ? 1 : 0;
    linIni[i + 1]++;
    porSku[s]++;
  }
  for (let i = 0; i < nDias; i++) linIni[i + 1] += linIni[i];
  const offFila = new Int32Array(nSku + 1);
  for (let s = 0; s < nSku; s++) offFila[s + 1] = offFila[s] + porSku[s];
  // CMC e estoque inicial
  const cmc = new Float64Array(nSku);
  const skusSemCmc: string[] = [];
  const inicialArr = new Float64Array(nSku);
  // I1: na CALIBRAÇÃO, valora pelo último cmcLinha conhecido até o fim dela (o cmc de hoje é futuro para quem decide em
  // 30/04); na avaliação, o cmc de hoje como numerário constante (declarado). Sem cmc ⇒ fora do capital (skusSemCmc).
  const calibracao = janela[1] <= JANELAS.calibracaoFim;
  const cmcCalib = new Map<string, { data: Data; cmc: number }>();
  if (calibracao) {
    for (const v of dados.vendas) {
      if (v.cmcLinha === null || !(v.cmcLinha > 0) || v.data > JANELAS.calibracaoFim || !idxSku.has(v.sku)) continue;
      const atual = cmcCalib.get(v.sku);
      if (!atual || v.data > atual.data) cmcCalib.set(v.sku, { data: v.data, cmc: v.cmcLinha });
    }
  }
  for (let s = 0; s < nSku; s++) {
    const c = calibracao ? (cmcCalib.get(skus[s])?.cmc ?? null) : skuObj[s].cmc;
    cmc[s] = c === null ? NaN : c;
    if (c === null) skusSemCmc.push(skus[s]);
    inicialArr[s] = ini.get(skus[s])!;
  }
  // compras abertas no início: recebimento físico (sku, t4) de documento com t1 < início <= t4
  const abertasNoInicio = new Set<string>();
  for (const it of dados.itensLT) if (it.t4 !== null && it.t1 < INICIO_AQUECIMENTO && it.t4 >= INICIO_AQUECIMENTO) abertasNoInicio.add(`${it.sku}|${it.t4}`);
  const chegIni: Plano['chegIni'] = [];
  for (const r of dados.recebimentos) {
    const s = idxSku.get(r.sku);
    if (s === undefined || r.data > janela[1] || !abertasNoInicio.has(`${r.sku}|${r.data}`)) continue;
    chegIni.push({ i: diffDias(INICIO_AQUECIMENTO, r.data), s, q: r.quantidade });
  }
  // grupos de embalagem
  const membros: Plano['membros'] = new Array(nSku).fill(null);
  const grupo: Plano['grupo'] = new Array(nSku).fill(null);
  const ehMembroNaoAncora = new Uint8Array(nSku);
  const equivs: Plano['equivs'] = skus.map(() => []);
  for (let s = 0; s < nSku; s++) {
    const g = grupoDeEmbalagem(dados, skus[s]);
    if (!g) continue;
    if (g.ancora === skus[s]) {
      membros[s] = Int32Array.from(g.membros.map((m) => idxSku.get(m)).filter((x): x is number => x !== undefined));
      grupo[s] = { conv: convDoGrupo(dados, skus[s])! };
    } else ehMembroNaoAncora[s] = 1;
    for (const m of g.membros) {
      const j = idxSku.get(m);
      const e = (dados.equivalencias ?? []).find((x) => x.sku === m);
      if (j === undefined || j === s || !e || e.unidadesOmieSku === null || !(e.unidadesOmieSku > 0)) continue;
      equivs[s].push({ j, u: e.unidadesOmieSku });
    }
  }
  return {
    skus, skuObj, idxSku, nDias, iJanela, dias, util, cntDu, duPos: Int32Array.from(duLista), semana, semanas, diasPorSemana,
    linIni, linSku, linQtd, linVu, linCmc, linId, linDia, linCel, linAlt, linMedida, offFila, cmc, skusSemCmc, inicial: inicialArr,
    chegIni, membros, grupo, ehMembroNaoAncora, equivs, excluidos, linhasIgnoradas, itens,
  };
}

/** Parâmetros resolvidos por (SKU, dia útil do horizonte): plano.skus × duPos. Memo pela identidade do mapa. */
const memoParams = new WeakMap<Map<string, ParamsDia>, { plano: Plano; formula: Formula; arr: (ParamsDia | null)[] }>();
function resolverParams(plano: Plano, params: Map<string, ParamsDia>, formula: Formula): (ParamsDia | null)[] {
  const m = memoParams.get(params);
  if (m && m.plano === plano && m.formula === formula) return m.arr;
  const nDu = plano.duPos.length;
  const arr: (ParamsDia | null)[] = new Array(plano.skus.length * nDu).fill(null);
  for (let s = 0; s < plano.skus.length; s++) {
    for (let k = 0; k < nDu; k++) {
      const chave = `${plano.skus[s]}|${plano.dias[plano.duPos[k]]}`;
      const p = params.get(chave);
      if (p === undefined) throw new Error(`PARAMS_AUSENTES:${chave}`);
      if (formula === 'F0' && p.tipo === 'S') throw new Error(`FORMULA_INCOERENTE:${chave}`);
      if (p.tipo !== 'SEM_DECISAO' && plano.ehMembroNaoAncora[s]) throw new Error(`GRUPO_MEMBRO_COM_DECISAO:${chave}`);
      arr[s * nDu + k] = p.tipo === 'SEM_DECISAO' ? null : p;
    }
  }
  memoParams.set(params, { plano, formula, arr });
  return arr;
}

/** Fechamento por SKU (unidades, linhas medidas): demanda = imediata + tardia + emergencial + cancelada + backlog. */
export function conferirFechamento(sku: string, demanda: number, desfechos: number): void {
  if (Math.abs(demanda - desfechos) > 1e-6 * Math.max(1, demanda)) throw new Error(`FECHAMENTO_VIOLADO:${sku}:${demanda}≠${desfechos}`);
}
/**
 * Estoque inicial + recebido − entregue = final. Tautológico por construção (os 3 acumuladores andam junto com o estoque):
 * só detecta deriva numérica ou um caminho futuro que mexa no estoque sem contabilizar.
 */
export function conferirEstoque(sku: string, inicial: number, recebido: number, entregue: number, final: number): void {
  const esperado = inicial + recebido - entregue;
  if (Math.abs(esperado - final) > 1e-6 * Math.max(1, Math.abs(esperado))) throw new Error(`ESTOQUE_NAO_FECHA:${sku}`);
}

// ── simulação ──────────────────────────────────────────────────────────────────────────────────────────────────
export function simular(e: EntradaSimulacao): SomasSemanais {
  const { dados, janela, rep, falta } = e;
  const calib = janela[1] <= JANELAS.calibracaoFim;
  const itens = e.itensLT ?? itensPadrao(dados, calib);
  const skusP = skusDoMapa(e.params);
  const chave = `${skusP.join(',')}|${janela[0]}|${janela[1]}|${e.inicial}|${e.alterados ? [...e.alterados].sort().join(',') : 'coorte'}`;
  let porDados = memoPlanos.get(dados);
  if (!porDados) memoPlanos.set(dados, (porDados = new Map()));
  let plano = porDados.get(chave);
  if (!plano || plano.itens !== itens) porDados.set(chave, (plano = montarPlano(dados, skusP, janela, e.inicial, itens, e.alterados)));
  const pArr = resolverParams(plano, e.params, e.formula);
  const P = plano;
  const nSku = P.skus.length;
  const nDu = P.duPos.length;
  const nSem = P.semanas.length;
  const sub = e.substituicao === true;
  // misto (spec §6): [0, espera) espera · [espera, espera+emergencial) emergencial · resto cancelamento
  const pEspera = CENARIOS_FALTA.misto.espera;
  const pEmerg = CENARIOS_FALTA.misto.espera + CENARIOS_FALTA.misto.emergencial;

  // estado
  const est = Float64Array.from(P.inicial);
  const abertas = new Float64Array(nSku);
  const backlog = new Float64Array(nSku);
  const recebido = new Float64Array(nSku);
  const entregueEst = new Float64Array(nSku);
  const saldo = new Float64Array(P.linQtd.length);
  const fila = new Int32Array(P.linQtd.length);
  const head = new Int32Array(nSku);
  const tail = new Int32Array(nSku);
  // fechamento (unidades, linhas medidas)
  const demU = new Float64Array(nSku);
  const imU = new Float64Array(nSku);
  const taU = new Float64Array(nSku);
  const emU = new Float64Array(nSku);
  const caU = new Float64Array(nSku);
  // somas
  const cel = { dem: new Float64Array(NC * nSem), int: new Float64Array(NC * nSem), uDem: new Float64Array(NC * nSem), uAt: new Float64Array(NC * nSem), vDem: new Float64Array(NC * nSem), vAt: new Float64Array(NC * nSem) };
  const capital = new Float64Array(nSem);
  const imediata = new Float64Array(nSem);
  const tardia = new Float64Array(nSem);
  const emergencial = new Float64Array(nSem);
  const cancV = new Float64Array(nSem);
  const cancM = new Float64Array(nSem);
  const cancComCmc = new Float64Array(nSem);
  const semCmcL = new Float64Array(nSem);
  const semCmcV = new Float64Array(nSem);
  const atraso = new Float64Array(nSem);
  // chegadas: listas encadeadas por dia
  const chHead = new Int32Array(P.nDias).fill(-1);
  const chNext: number[] = [];
  const chSku: number[] = [];
  const chQtd: number[] = [];
  const agendar = (i: number, s: number, q: number) => {
    chNext.push(chHead[i]);
    chSku.push(s);
    chQtd.push(q);
    chHead[i] = chSku.length - 1;
  };
  for (const c of P.chegIni) {
    abertas[c.s] += c.q;
    agendar(c.i, c.s, c.q);
  }
  const pedidos: NonNullable<SomasSemanais['pedidos']> | undefined = e.rastro ? [] : undefined;
  const desfechos: NonNullable<SomasSemanais['desfechos']> | undefined = e.rastro ? [] : undefined;

  const somaCel = (arr: Float64Array, w: number, c: number, a: number, v: number) => {
    arr[c * nSem + w] += v;
    if (a >= 0) arr[a * nSem + w] += v;
    arr[CEL_TOTAL * nSem + w] += v;
  };

  for (let i = 0; i < P.nDias; i++) {
    const w = P.semana[i];
    // 1. chegadas
    for (let k = chHead[i]; k >= 0; k = chNext[k]) {
      const s = chSku[k];
      est[s] += chQtd[k];
      abertas[s] -= chQtd[k];
      recebido[s] += chQtd[k];
    }
    // 2. obrigações FIFO
    for (let s = 0; s < nSku; s++) {
      if (head[s] === tail[s] || !(est[s] > EPS)) continue;
      const off = P.offFila[s];
      while (head[s] < tail[s] && est[s] > EPS) {
        const L = fila[off + head[s]];
        const q = est[s] >= saldo[L] - EPS ? saldo[L] : est[s];
        est[s] -= q;
        saldo[L] -= q;
        backlog[s] -= q;
        entregueEst[s] += q;
        if (P.linMedida[L]) {
          const v = q * P.linVu[L];
          tardia[w] += v;
          atraso[w] += v * (i - P.linDia[L]);
          taU[s] += q;
        }
        if (saldo[L] === 0) head[s]++;
      }
    }
    // 3. linhas do dia
    for (let L = P.linIni[i]; L < P.linIni[i + 1]; L++) {
      const s = P.linSku[L];
      const q = P.linQtd[L];
      let ent: number;
      let integral: boolean;
      if (est[s] >= q - EPS) {
        ent = q;
        integral = true;
        est[s] -= q;
        entregueEst[s] += q;
      } else {
        ent = est[s] > 0 ? est[s] : 0;
        integral = false;
        est[s] -= ent;
        entregueEst[s] += ent;
        if (sub) {
          const rem = q - ent;
          for (const { j, u } of P.equivs[s]) {
            const emb = rem / u;
            if (est[j] >= rem - EPS && Math.abs(emb - Math.round(emb)) <= 1e-6 && Math.round(emb) >= 1) {
              est[j] -= rem;
              entregueEst[j] += rem;
              ent = q;
              integral = true;
              break;
            }
          }
        }
      }
      const medida = P.linMedida[L] === 1;
      const vu = P.linVu[L];
      if (medida) {
        const c = P.linCel[L];
        const a = P.linAlt[L];
        somaCel(cel.dem, w, c, a, 1);
        if (integral) somaCel(cel.int, w, c, a, 1);
        somaCel(cel.uDem, w, c, a, q);
        somaCel(cel.uAt, w, c, a, ent);
        somaCel(cel.vDem, w, c, a, q * vu);
        somaCel(cel.vAt, w, c, a, ent * vu);
        imediata[w] += ent * vu;
        demU[s] += q;
        imU[s] += ent;
      }
      if (integral) continue;
      const rem = q - ent;
      let desfecho: 0 | 1 | 2; // 0 espera, 1 cancelamento, 2 emergencial
      if (falta === 'espera') desfecho = 0;
      else if (falta === 'cancelamento') desfecho = 1;
      else {
        const u = uniforme(rep, 'falta', P.linId[L]);
        desfecho = u < pEspera ? 0 : u < pEmerg ? 2 : 1;
      }
      if (desfechos) desfechos.push({ linhaId: P.linId[L], desfecho: desfecho === 0 ? 'espera' : desfecho === 1 ? 'cancelamento' : 'emergencial' });
      if (desfecho === 0) {
        saldo[L] = rem;
        fila[P.offFila[s] + tail[s]++] = L;
        backlog[s] += rem;
      } else if (medida) {
        const v = rem * vu;
        if (desfecho === 2) {
          emergencial[w] += v;
          emU[s] += rem;
        } else {
          cancV[w] += v;
          const cm = P.linCmc[L];
          if (Number.isNaN(cm)) {
            semCmcL[w] += 1;
            semCmcV[w] += v;
          } else {
            cancM[w] += v - cm * rem;
            cancComCmc[w] += 1;
          }
          caU[s] += rem;
        }
      }
    }
    // 4. compra (só dia útil)
    if (P.util[i]) {
      const k = P.cntDu[i] - 1;
      for (let s = 0; s < nSku; s++) {
        const p = pArr[s * nDu + k];
        if (p === null) continue;
        let pos = 0;
        const ms = P.membros[s];
        if (ms) for (let x = 0; x < ms.length; x++) pos += est[ms[x]] + abertas[ms[x]] - backlog[ms[x]];
        else pos = est[s] + abertas[s] - backlog[s];
        const g = P.grupo[s];
        const qMotor = decidirCompra(p, pos, P.skuObj[s], g);
        if (qMotor <= 0) continue;
        const q = g === null ? qMotor : qMotor * g.conv;
        const lt = ltRealizado(rep, P.dias[i], P.skus[s], e.lt, P.itens);
        const kk = k + Math.max(1, lt);
        abertas[s] += q;
        let chegada: Data | null = null;
        if (kk < nDu) {
          agendar(P.duPos[kk], s, q);
          chegada = P.dias[P.duPos[kk]];
        }
        if (pedidos) pedidos.push({ dia: P.dias[i], sku: P.skus[s], qtd: q, chegada });
      }
    }
    // capital (fim do dia, por dia corrido)
    if (w >= 0) {
      let v = 0;
      for (let s = 0; s < nSku; s++) if (!Number.isNaN(P.cmc[s])) v += est[s] * P.cmc[s];
      capital[w] += v;
    }
  }

  // terminal
  const iFim = P.nDias - 1;
  let estoqueCmc = 0;
  let abertasCmc = 0;
  let backlogValor = 0;
  let backlogDiasAtraso = 0;
  const bal = { inicial: 0, recebido: 0, entregue: 0, final: 0 };
  for (let s = 0; s < nSku; s++) {
    if (!Number.isNaN(P.cmc[s])) {
      estoqueCmc += est[s] * P.cmc[s];
      abertasCmc += abertas[s] * P.cmc[s];
    }
    let bkU = 0;
    for (let h = head[s]; h < tail[s]; h++) {
      const L = fila[P.offFila[s] + h];
      if (!P.linMedida[L]) continue;
      const v = saldo[L] * P.linVu[L];
      backlogValor += v;
      backlogDiasAtraso += v * (iFim - P.linDia[L]);
      bkU += saldo[L];
    }
    conferirFechamento(P.skus[s], demU[s], imU[s] + taU[s] + emU[s] + caU[s] + bkU);
    conferirEstoque(P.skus[s], P.inicial[s], recebido[s], entregueEst[s], est[s]);
    bal.inicial += P.inicial[s];
    bal.recebido += recebido[s];
    bal.entregue += entregueEst[s];
    bal.final += est[s];
  }

  const fatia = (arr: Float64Array, c: number) => Array.from(arr.subarray(c * nSem, (c + 1) * nSem));
  const porCelula = {} as Record<Celula, SomasCelula>;
  CELULAS.forEach((nome, c) => {
    porCelula[nome] = { demandadas: fatia(cel.dem, c), integrais: fatia(cel.int, c), unidDem: fatia(cel.uDem, c), unidAt: fatia(cel.uAt, c), valorDem: fatia(cel.vDem, c), valorAt: fatia(cel.vAt, c) };
  });
  const out: SomasSemanais = {
    semanas: [...P.semanas],
    porCelula,
    estoqueCmcDias: Array.from(capital),
    diasCorridos: [...P.diasPorSemana],
    entregue: { imediata: Array.from(imediata), tardia: Array.from(tardia), emergencial: Array.from(emergencial) },
    cancelada: { valor: Array.from(cancV), margem: Array.from(cancM, (m, w) => (semCmcL[w] > 0 && cancComCmc[w] === 0 ? null : m)) },
    canceladaSemCmc: { linhas: Array.from(semCmcL), valor: Array.from(semCmcV) },
    valorDiasAtraso: Array.from(atraso),
    terminal: { estoqueCmc, abertasCmc, backlogValor, backlogDiasAtraso },
    balanco: bal,
    skusSemCmc: [...P.skusSemCmc],
    excluidos: [...P.excluidos],
    linhasIgnoradas: P.linhasIgnoradas,
  };
  if (pedidos) out.pedidos = pedidos;
  if (desfechos) out.desfechos = desfechos;
  return out;
}

// ── paridade de QUANTIDADE (R20) ──────────────────────────────────────────────────────────────────────────────────
export interface LinhaParidadeQtd {
  sku: string;
  posicao: number;
  qtdeFinal: number;
  /** decidirCompra com os parâmetros F0 do REPLAY no dia da extração (estado gravado depois da passada do dia). */
  replay: number | null;
  /** decidirCompra com o PP/máximo GRAVADOS hoje em produção (sku.hoje): isola a DECISÃO do estado dos parâmetros. */
  gravado: number | null;
  /** null = comparável; senão por que ficou fora (informativo, R20). */
  fora: 'FORA_DOS_DADOS' | 'MEMBRO_GRUPO_NAO_ANCORA' | null;
}
export interface ParidadeQuantidade {
  linhas: LinhaParidadeQtd[];
  replay: { n: number; de: number };
  gravado: { n: number; de: number };
}

/**
 * R20: para cada SKU da última execução do motor (sugestao_hoje), a decisão do replay sobre a posição GRAVADA lá deve dar a
 * `qtde_final`. Duas leituras: com os parâmetros do replay (fórmula + estado) e com o PP/máximo gravados (só a decisão).
 */
export function paridadeQuantidade(dados: Dados, paramsF0Hoje: (sku: string) => ParamsDia): ParidadeQuantidade {
  const out: ParidadeQuantidade = { linhas: [], replay: { n: 0, de: 0 }, gravado: { n: 0, de: 0 } };
  const bate = (a: number, b: number) => Math.abs(a - b) <= 1e-6;
  for (const [sku, { posicao, qtdeFinal }] of [...dados.sugestaoHoje].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const s = dados.skus.get(sku);
    const g = s ? grupoDeEmbalagem(dados, sku) : null;
    const fora = !s ? 'FORA_DOS_DADOS' : g && g.ancora !== sku ? 'MEMBRO_GRUPO_NAO_ANCORA' : null;
    const linha: LinhaParidadeQtd = { sku, posicao, qtdeFinal, replay: null, gravado: null, fora };
    out.linhas.push(linha);
    if (fora !== null || !s) continue;
    const grupo = g ? { conv: convDoGrupo(dados, sku)! } : null;
    const p = paramsF0Hoje(sku);
    linha.replay = decidirCompra(p, posicao, s, grupo);
    out.replay.de++;
    if (bate(linha.replay, qtdeFinal)) out.replay.n++;
    if (p.tipo === 'F0' && s.hoje.pp !== null && s.hoje.max !== null) {
      linha.gravado = decidirCompra({ ...p, pp: s.hoje.pp, max: s.hoje.max }, posicao, s, grupo);
      out.gravado.de++;
      if (bate(linha.gravado, qtdeFinal)) out.gravado.n++;
    }
  }
  return out;
}
