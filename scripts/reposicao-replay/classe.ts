// Classe ABC do dia, versionada (spec §5.1.1). Reproduz, sobre TODO o universo OBEN e com dados < d:
//  (1) a PROPOSTA: Pareto por empresa de `v_sku_classificacao_abc_xyz` (schema-snapshot.sql ~30319 e a view-base
//      `v_sku_demanda_estatisticas` ~30268): valor_total_90d = soma de valor_total das vendas com data_emissao >= hoje-90d;
//      acumulado = soma ordenada por valor DESC, com empates (RANGE) compartilhando o mesmo acumulado; A se acumulado/total <= 0,80,
//      B se <= 0,95, senão C; total 0 => C. A letra XYZ vem do CV da quantidade por ORDEM (< 0,4 X; < 0,8 Y; senão Z; < 2 ordens => Z).
//  (2) a APLICAÇÃO: histerese de `atualizar_classificacao_skus` (~5798), sobre a classe de 9 posições (ABC+XYZ), com limites
//      meses_subir/meses_descer lidos de `classificacaoHist.regras` (conferidos na produção por pg_get_functiondef).
//  Todos os parâmetros vêm das regras gravadas pela Task 1; faltar uma regra é erro, nunca default silencioso.
//
// LIMITAÇÕES declaradas (vão para o relatório):
//  - O extrato não traz a chave da NF; "ordem" (CV do XYZ) é aproximada por (SKU, dia). Duas NFs do mesmo SKU no mesmo dia viram uma.
//  - Linhas de consumo de insumo derivado da ficha técnica (v_sku_demanda_efetiva, valor NULL) não estão no extrato.
//  - O estado inicial da histerese não existe historicamente: cada SKU entra (CASO 1 de produção) com a classe proposta no
//    1º dia em que aparece na janela, sem pendência. Nos primeiros 90 dias do replay a janela do Pareto é MENOR que 90 dias.
//  - `classe_forcada` é a de HOJE (sem histórico de vigência).
import { addDias } from '../../src/lib/reposicao/orcamento-compra/datas';
import { INICIO_AQUECIMENTO } from './config';
import type { Classe, Dados, Data } from './tipos';

export type DadosClasse = Pick<Dados, 'vendas' | 'skus' | 'classificacaoHist' | 'recebimentos' | 'dataExtracao'>;

// Cron `afiacao_omie_oben_sync_incremental_2h` (a cada 2h, minuto 15) chama omie-cron-diario, que roda atualizar_classificacao_skus a CADA tick.
export const CADENCIA_PRODUCAO: Cadencia = { ticksPorDia: 12 };
/** Cadência hipotética (1 passada por mês) — só para sensibilidade, NÃO é a de produção. */
export const CADENCIA_MENSAL: Cadencia = { ticksPorDia: 1, apenasDia1: true };
export interface Cadencia {
  /** Passadas de atualizar_classificacao_skus por dia (cada uma incrementa a pendência). */
  ticksPorDia: number;
  /** Só roda no dia 1 de cada mês (e no 1º dia do histórico). */
  apenasDia1?: boolean;
}
/** Janela de venda do Pareto (dias), como `v_sku_demanda_estatisticas`. */
export const JANELA_PARETO_DIAS = 90;

interface Regras {
  subir: number;
  descer: number;
  ordem: string[];
  /** Cortes em centésimos (0,80 => 80) para comparar em inteiros. */
  corteA: number;
  corteB: number;
  cvX: number;
  cvY: number;
  minOrdens: number;
}

function numeroRegra(r: Record<string, string>, k: string): number {
  const t = r[k];
  const n = t === undefined ? NaN : Number(t);
  if (!Number.isFinite(n)) throw new Error(`REGRA_CLASSIFICACAO_AUSENTE:${k}`);
  return n;
}

export function lerRegras(dados: Pick<Dados, 'classificacaoHist'>): Regras {
  const r = dados.classificacaoHist.regras;
  const ordem = (r.ordem_prioridade ?? '').split(/\s+/).filter(Boolean);
  if (ordem.length === 0) throw new Error('REGRA_CLASSIFICACAO_AUSENTE:ordem_prioridade');
  const centesimos = (k: string) => {
    const c = numeroRegra(r, k) * 100;
    if (Math.abs(c - Math.round(c)) > 1e-9) throw new Error(`REGRA_CLASSIFICACAO_INVALIDA:${k}`);
    return Math.round(c);
  };
  return {
    subir: numeroRegra(r, 'meses_subir'), descer: numeroRegra(r, 'meses_descer'), ordem,
    corteA: centesimos('abc_corte_a_acumulado'), corteB: centesimos('abc_corte_b_acumulado'),
    cvX: numeroRegra(r, 'xyz_corte_x_cv'), cvY: numeroRegra(r, 'xyz_corte_y_cv'), minOrdens: numeroRegra(r, 'xyz_min_ordens'),
  };
}

/** Proposta de 9 posições (ex.: 'BZ') para cada SKU com venda em [d-90, d). SKU sem venda na janela não aparece (como na view). */
export function classe9Proposta(dados: Pick<Dados, 'vendas' | 'classificacaoHist'>, d: Data): Map<string, string> {
  const R = lerRegras(dados);
  const ini = addDias(d, -JANELA_PARETO_DIAS);
  const valorCent = new Map<string, number>(); // centavos inteiros: soma exata, comparação sem erro de ponto flutuante
  const porOrdem = new Map<string, Map<Data, number>>();
  for (const v of dados.vendas) {
    if (v.data < ini || v.data >= d) continue;
    valorCent.set(v.sku, (valorCent.get(v.sku) ?? 0) + Math.round(v.valor * 100));
    let o = porOrdem.get(v.sku);
    if (!o) porOrdem.set(v.sku, (o = new Map()));
    o.set(v.data, (o.get(v.data) ?? 0) + v.quantidade);
  }
  const itens = [...valorCent].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const total = itens.reduce((s, [, c]) => s + c, 0);
  const abc = new Map<string, string>();
  let acum = 0;
  for (let i = 0; i < itens.length; ) {
    let j = i;
    while (j < itens.length && itens[j][1] === itens[i][1]) j++; // empates compartilham o acumulado (RANGE padrão)
    for (let k = i; k < j; k++) acum += itens[k][1];
    const letra = total === 0 ? 'C' : acum * 100 <= R.corteA * total ? 'A' : acum * 100 <= R.corteB * total ? 'B' : 'C';
    for (let k = i; k < j; k++) abc.set(itens[k][0], letra);
    i = j;
  }
  const out = new Map<string, string>();
  for (const [sku] of itens) out.set(sku, abc.get(sku)! + letraXyz(porOrdem.get(sku)!, R));
  return out;
}

function letraXyz(ordens: Map<Data, number>, R: Regras): string {
  const q = [...ordens.values()];
  if (q.length < R.minOrdens) return 'Z';
  const media = q.reduce((s, x) => s + x, 0) / q.length;
  if (!(media > 0) || q.length < 2) return 'Z'; // coef_variacao_ordem NULL => Z
  const dp = Math.sqrt(q.reduce((s, x) => s + (x - media) ** 2, 0) / (q.length - 1)); // stddev amostral, como o PG
  const cv = Math.round((dp / media) * 1e4) / 1e4; // a view arredonda o CV a 4 casas antes de comparar
  return cv < R.cvX ? 'X' : cv < R.cvY ? 'Y' : 'Z';
}

/** Letra ABC proposta (Pareto), dados < d. */
export function classeProposta(dados: Pick<Dados, 'vendas' | 'classificacaoHist'>, d: Data): Map<string, Classe> {
  const m = new Map<string, Classe>();
  for (const [sku, c9] of classe9Proposta(dados, d)) m.set(sku, c9[0] as Classe);
  return m;
}

export interface EstadoHisterese {
  atual: string;
  pendente: string | null;
  meses: number;
}

/** Uma passada de `atualizar_classificacao_skus` para UM SKU que apareceu na view. `estado` indefinido = SKU novo (CASO 1). */
export function passoHisterese(
  estado: EstadoHisterese | undefined,
  proposta: string,
  regras: { subir: number; descer: number; ordem: string[] },
): EstadoHisterese {
  if (!estado) return { atual: proposta, pendente: null, meses: 1 }; // CASO 1
  if (estado.atual === proposta) return { atual: estado.atual, pendente: null, meses: 0 }; // CASO 2
  if (estado.pendente === proposta) {
    // CASO 3
    const meses = (estado.meses ?? 0) + 1;
    const subindo = regras.ordem.indexOf(proposta) < regras.ordem.indexOf(estado.atual);
    const aplicar = subindo ? meses >= regras.subir : meses >= regras.descer;
    return aplicar ? { atual: proposta, pendente: null, meses: 0 } : { atual: estado.atual, pendente: proposta, meses };
  }
  return { atual: estado.atual, pendente: proposta, meses: 1 }; // CASO 4
}

interface Trajetoria {
  ate: Data | null; // último dia já processado
  estado: Map<string, EstadoHisterese>;
  fotos: Map<Data, Map<string, string>>; // classe de 9 posições ao fim do dia
}
const memo = new WeakMap<object, Map<string, Trajetoria>>();

function ticksNoDia(c: Cadencia, dia: Data): number {
  if (c.apenasDia1 && !(dia.endsWith('-01') || dia === INICIO_AQUECIMENTO)) return 0;
  return c.ticksPorDia;
}

function trajetoria(dados: DadosClasse, d: Data, cad: Cadencia): Trajetoria {
  let porCad = memo.get(dados.vendas);
  if (!porCad) memo.set(dados.vendas, (porCad = new Map()));
  const chave = `${JSON.stringify(dados.classificacaoHist.regras)}|${cad.ticksPorDia}|${cad.apenasDia1 ? 1 : 0}`;
  let t = porCad.get(chave);
  if (!t) porCad.set(chave, (t = { ate: null, estado: new Map(), fotos: new Map() }));
  const R = lerRegras(dados);
  let dia = t.ate === null ? INICIO_AQUECIMENTO : addDias(t.ate, 1);
  for (; dia <= d; dia = addDias(dia, 1)) {
    const n = ticksNoDia(cad, dia);
    if (n > 0) {
      const prop = classe9Proposta(dados, dia);
      for (const [sku, c9] of prop) {
        let e = t.estado.get(sku);
        for (let i = 0; i < n; i++) e = passoHisterese(e, c9, R);
        t.estado.set(sku, e!);
      }
    }
    t.fotos.set(dia, new Map([...t.estado].map(([s, e]) => [s, e.atual])));
    t.ate = dia;
  }
  return t;
}

/**
 * Classe efetiva (letra) de cada SKU ao fim da(s) passada(s) do dia d, vendo só dados < d. Parte da proposta do 1º dia em que o SKU
 * aparece (sem estado histórico). `classeForcada` (de hoje) prevalece. Antes do início do histórico: só as forçadas.
 */
export function classeEfetiva(dados: DadosClasse, d: Data, cad: Cadencia = CADENCIA_PRODUCAO): Map<string, Classe> {
  const out = new Map<string, Classe>();
  if (d >= INICIO_AQUECIMENTO) {
    const foto = trajetoria(dados, d, cad).fotos.get(d);
    for (const [sku, c9] of foto ?? []) out.set(sku, c9[0] as Classe);
  }
  for (const s of dados.skus.values()) if (s.classeForcada) out.set(s.sku, s.classeForcada);
  return out;
}

export interface ValidacaoClasse {
  /** % do valor (90d) dos SKUs cuja classe de HOJE é c e cuja efetiva recalculada difere (ou não existe). null = sem valor na classe. */
  porClasse: Record<Classe, number | null>;
  /**
   * % do valor A: soma do valor dos SKUs em que a classe de hoje ou a recalculada é A e diferem, sobre o valor da classe A
   * de hoje. null = sem valor A hoje (não mensurável; nunca 0% fabricado).
   */
  valorADivergente: number | null;
  detalhe: { skusComparados: number; skusSemClasseReconstruida: number; skusDivergentes: number; skusDivergentesNaClasseA: number };
}

/** Efetiva recalculada em `dataExtracao` contra `classe_abc_hoje`, por classe e ponderada pelo valor da janela de 90 dias. */
export function validarClasse(dados: DadosClasse, cad: Cadencia = CADENCIA_PRODUCAO): ValidacaoClasse {
  const d = dados.dataExtracao;
  const efetiva = classeEfetiva(dados, d, cad);
  const ini = addDias(d, -JANELA_PARETO_DIAS);
  const valor = new Map<string, number>();
  for (const v of dados.vendas) if (v.data >= ini && v.data < d) valor.set(v.sku, (valor.get(v.sku) ?? 0) + v.valor);
  const base: Record<Classe, number> = { A: 0, B: 0, C: 0 };
  const dif: Record<Classe, number> = { A: 0, B: 0, C: 0 };
  let divA = 0;
  const det = { skusComparados: 0, skusSemClasseReconstruida: 0, skusDivergentes: 0, skusDivergentesNaClasseA: 0 };
  for (const s of dados.skus.values()) {
    if (!s.classeAbcHoje) continue;
    det.skusComparados++;
    const w = Math.max(0, valor.get(s.sku) ?? 0);
    const ef = efetiva.get(s.sku) ?? null;
    if (ef === null) det.skusSemClasseReconstruida++;
    base[s.classeAbcHoje] += w;
    if (ef !== s.classeAbcHoje) {
      det.skusDivergentes++;
      dif[s.classeAbcHoje] += w;
      if (s.classeAbcHoje === 'A' || ef === 'A') {
        det.skusDivergentesNaClasseA++;
        divA += w;
      }
    }
  }
  const pct = (x: number, b: number): number | null => (b > 0 ? (100 * x) / b : null);
  return {
    porClasse: { A: pct(dif.A, base.A), B: pct(dif.B, base.B), C: pct(dif.C, base.C) },
    valorADivergente: pct(divA, base.A),
    detalhe: det,
  };
}

