// F4 — Antecipação de recebíveis. Helper PURO (vitest). Sem I/O.
// Spec: docs/superpowers/specs/2026-07-07-antecipacao-recebiveis-design.md
// Precisão > recall: degrada por motivo (nunca fabrica R$). Datas ISO puras (UTC-midnight).
import type {
  Antecipacao,
  CustoOperacao,
  FundingInput,
  FundingResult,
  HurdleSugerido,
  HurdleUnidade,
  MedidorResult,
  MesAntecipacao,
} from './antecipacao-types';

const MS_DIA = 86_400_000;
/** Dias corridos entre duas datas ISO puras, ancoradas em UTC-midnight (sem drift de fuso). */
export function diasEntre(operISO: string, vencISO: string): number {
  const a = Date.parse(operISO + 'T00:00:00Z');
  const b = Date.parse(vencISO + 'T00:00:00Z');
  return Math.round((b - a) / MS_DIA);
}

type OpCusto = Pick<
  Antecipacao,
  'valor_bruto' | 'custos_avulsos' | 'valor_liquido' | 'data_operacao' | 'data_vencimento'
>;

const INVALIDO: CustoOperacao = {
  motivo: 'dados_invalidos',
  custo: null,
  dias: null,
  taxa_periodo: null,
  taxa_efetiva_aa: null,
};

/** Custo e taxas de UMA operação. Blinda os invariantes (o CHECK barra no banco; aqui defende o agregado). */
export function custoOperacao(op: OpCusto): CustoOperacao {
  const bruto = Number(op.valor_bruto);
  const avulsos = Number(op.custos_avulsos);
  const liquido = Number(op.valor_liquido);
  if (![bruto, avulsos, liquido].every(Number.isFinite)) return INVALIDO;
  if (!(bruto > 0) || !(liquido > 0) || avulsos < 0) return INVALIDO; // P1-1: valores positivos
  const base = bruto + avulsos;
  if (liquido > base) return INVALIDO; // P1-1: inválido SÓ se líquido > base
  const dias = diasEntre(op.data_operacao, op.data_vencimento);
  if (!(dias > 0)) return INVALIDO; // prazo positivo
  const custo = base - liquido; // P1-4: avulsos entram
  const taxa_periodo = base / liquido - 1;
  const taxa_efetiva_aa = Math.pow(1 + taxa_periodo, 365 / dias) - 1; // normalização (nunca métrica única, §3)
  return { motivo: 'ok', custo, dias, taxa_periodo, taxa_efetiva_aa };
}

/** Job A — medidor de custo do período. Métrica primária = caixa (R$), taxa money-weighted (P1-2).
 *  Exclui soft-deleted; linhas inválidas são excluídas e sinalizadas (dados_parciais). */
export function medirCusto(ops: Antecipacao[]): MedidorResult {
  const vivos = ops.filter((o) => o.deleted_at == null);
  if (vivos.length === 0) {
    return {
      motivo: 'sem_operacoes',
      custo_total: null,
      volume_antecipado: null,
      taxa_realizada_aa: null,
      num_operacoes: 0,
      num_excluidas: 0,
      tendencia: [],
    };
  }
  let custoTotal = 0;
  let volume = 0;
  let capitalTempo = 0;
  let excluidas = 0;
  const porMes = new Map<string, MesAntecipacao>();
  for (const o of vivos) {
    const c = custoOperacao(o);
    if (c.motivo !== 'ok' || c.custo == null || c.dias == null) {
      excluidas++;
      continue;
    }
    custoTotal += c.custo;
    volume += o.valor_liquido;
    capitalTempo += (o.valor_liquido * c.dias) / 365;
    const ano = Number(o.data_operacao.slice(0, 4));
    const mes = Number(o.data_operacao.slice(5, 7));
    const k = `${ano}-${mes}`;
    const m = porMes.get(k) ?? { ano, mes, custo: 0, volume: 0 };
    m.custo += c.custo;
    m.volume += o.valor_liquido;
    porMes.set(k, m);
  }
  const validas = vivos.length - excluidas;
  const tendencia = [...porMes.values()].sort((a, b) => a.ano * 12 + a.mes - (b.ano * 12 + b.mes));
  if (validas === 0) {
    return {
      motivo: 'dados_parciais',
      custo_total: null,
      volume_antecipado: null,
      taxa_realizada_aa: null,
      num_operacoes: 0,
      num_excluidas: excluidas,
      tendencia: [],
    };
  }
  const taxa = capitalTempo > 0 ? custoTotal / capitalTempo : null; // money-weighted anualizada
  return {
    motivo: excluidas > 0 ? 'dados_parciais' : 'ok',
    custo_total: custoTotal,
    volume_antecipado: volume,
    taxa_realizada_aa: taxa,
    num_operacoes: validas,
    num_excluidas: excluidas,
    tendencia,
  };
}

const UNIDADES: readonly HurdleUnidade[] = ['efetiva_aa', 'nominal_aa', 'efetiva_am'];

/** Converte uma taxa na sua unidade → taxa EFETIVA do período de `dias` (comparação no MESMO período, P1-3). */
export function taxaParaPeriodo(valor: number, unidade: HurdleUnidade, dias: number): number {
  switch (unidade) {
    case 'efetiva_aa':
      return Math.pow(1 + valor, dias / 365) - 1; // composta anual
    case 'efetiva_am':
      return Math.pow(1 + valor, dias / 30) - 1; // composta mensal
    case 'nominal_aa':
      return valor * (dias / 365); // linear/proporcional (juros simples)
  }
}

const FUNDING_INVALIDO = (m: FundingResult['motivo']): FundingResult => ({
  motivo: m,
  custo: null,
  taxa_periodo: null,
  taxa_efetiva_aa: null,
  hurdle_taxa_periodo: null,
  veredito: null,
});

/** Job B — comparação de custo de FUNDING (nunca "vale a pena"; isso depende do uso do caixa, §4). */
export function compararFunding(input: FundingInput): FundingResult {
  if (input.lote === true) return FUNDING_INVALIDO('fluxo_nao_suportado'); // P1-5: prazo inventado
  const face = Number(input.valor_titulo);
  const dias = Number(input.dias);
  const avulsos = Number(input.custos_avulsos ?? 0);
  if (![face, dias, avulsos].every(Number.isFinite) || !(face > 0) || !(dias > 0) || avulsos < 0) {
    return FUNDING_INVALIDO('dados_invalidos');
  }
  const base = face + avulsos;

  // Resolve o líquido da oferta: pode vir como líquido, como taxa (c/ unidade), ou ambos (reconciliar).
  const temLiquido = input.liquido_ofertado != null;
  const temTaxa = input.taxa_ofertada != null;
  if (!temLiquido && !temTaxa) return FUNDING_INVALIDO('dados_invalidos');

  let liquidoDeTaxa: number | null = null;
  if (temTaxa) {
    const u = input.taxa_ofertada!.unidade;
    const tv = Number(input.taxa_ofertada!.valor);
    if (!UNIDADES.includes(u)) return FUNDING_INVALIDO('hurdle_unidade_invalida');
    if (!Number.isFinite(tv) || tv < 0) return FUNDING_INVALIDO('dados_invalidos'); // P1-b: NaN/negativa
    const tp = taxaParaPeriodo(tv, u, dias);
    if (!(tp > -1)) return FUNDING_INVALIDO('dados_invalidos');
    // P1-c: a taxa da oferta incide sobre a FACE; os custos avulsos são custo À PARTE (fora do líquido).
    // Usar base=(face+avulsos) aqui subcontaria o custo quando há avulsos.
    liquidoDeTaxa = face / (1 + tp);
  }

  let liquido: number | null;
  if (temLiquido) {
    liquido = Number(input.liquido_ofertado);
    if (!Number.isFinite(liquido) || !(liquido > 0) || liquido > base) {
      return FUNDING_INVALIDO('dados_invalidos');
    }
    // taxa E líquido: reconciliar. Tolerância de ARREDONDAMENTO (limitada pela precisão da taxa,
    // 2 casas de %), não comercial — P1-d: 0,5% da face escondia conflito real de centenas de R$.
    if (liquidoDeTaxa != null && Math.abs(liquido - liquidoDeTaxa) > Math.max(0.01, 1e-4 * base)) {
      return FUNDING_INVALIDO('inputs_conflitantes');
    }
  } else {
    liquido = liquidoDeTaxa;
  }
  if (liquido == null || !(liquido > 0) || liquido > base) return FUNDING_INVALIDO('dados_invalidos');

  const custo = base - liquido;
  const taxa_periodo = base / liquido - 1;
  const taxa_efetiva_aa = Math.pow(1 + taxa_periodo, 365 / dias) - 1;

  // Hurdle editável PRIMÁRIO (P1-3): ausente → só custo; unidade inválida → sem veredito.
  if (input.hurdle == null) {
    return { motivo: 'hurdle_indisponivel', custo, taxa_periodo, taxa_efetiva_aa, hurdle_taxa_periodo: null, veredito: null };
  }
  // P1-b: unidade inválida OU valor não-finito/negativo → sem veredito (nunca um 'dentro' falso por NaN).
  if (
    !UNIDADES.includes(input.hurdle.unidade) ||
    !Number.isFinite(input.hurdle.valor) ||
    input.hurdle.valor < 0
  ) {
    return { motivo: 'hurdle_unidade_invalida', custo, taxa_periodo, taxa_efetiva_aa, hurdle_taxa_periodo: null, veredito: null };
  }
  const hurdle_taxa_periodo = taxaParaPeriodo(input.hurdle.valor, input.hurdle.unidade, dias);
  const veredito = taxa_periodo > hurdle_taxa_periodo ? 'mais_caro' : 'dentro';
  return { motivo: 'ok', custo, taxa_periodo, taxa_efetiva_aa, hurdle_taxa_periodo, veredito };
}

export type FluxoRegistro = 'um_vencimento' | 'lote' | 'rollover';

/** Guard de entrada (P1-e). O fluxo é declarado explicitamente (sem default silencioso):
 *  - 'lote' (vários vencimentos num prazo só) inventa prazo → não suportado (registrar 1 por título);
 *  - 'rollover' exige a operação de origem (senão o principal rolado seria re-contado). */
export function motivoFluxoRegistro(input: {
  fluxo?: FluxoRegistro;
  operacao_origem_id?: string | null;
}): 'ok' | 'fluxo_nao_suportado' {
  if (input.fluxo === 'lote') return 'fluxo_nao_suportado';
  if (input.fluxo === 'rollover' && !input.operacao_origem_id) return 'fluxo_nao_suportado';
  return 'ok';
}

/** Sugere um hurdle a partir do custo médio ponderado (por saldo) do CET das dívidas do F1.
 *  FALLBACK (P1-3): custo médio de dívida ativa ≠ custo marginal de hoje — o editável é primário.
 *  CET = efetiva a.a. → unidade 'efetiva_aa'. Ausente ≠ zero: ignora sem cet/saldo; nenhuma → sem_dados. */
export function sugerirHurdle(
  dividas: Array<{ saldo: number; cet_aa: number | null }>,
): HurdleSugerido {
  let pesoTotal = 0;
  let somaPond = 0;
  for (const d of dividas) {
    const saldo = Number(d.saldo);
    const cet = d.cet_aa;
    if (cet == null || !Number.isFinite(cet) || !Number.isFinite(saldo) || saldo <= 0) continue;
    pesoTotal += saldo;
    somaPond += saldo * cet;
  }
  if (pesoTotal <= 0) return { valor: null, unidade: null, motivo: 'sem_dados' };
  return { valor: somaPond / pesoTotal, unidade: 'efetiva_aa', motivo: 'ok' };
}
