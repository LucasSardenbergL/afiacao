export const LINHAS_INPUT = ['receita_bruta','deducoes','cmv','despesas_operacionais','despesas_administrativas','despesas_comerciais','despesas_financeiras','receitas_financeiras','outras_receitas','outras_despesas','impostos'] as const;
export type LinhaInput = typeof LINHAS_INPUT[number];
const LINHAS_RECEITA = new Set<string>(['receita_bruta','receitas_financeiras','outras_receitas']);
const LINHAS_DERIV_FAVORAVEL_CIMA = new Set<string>(['receita_liquida','lucro_bruto','resultado_operacional','resultado_antes_impostos','resultado_liquido']);
export type MesDRE = { mes: number } & Partial<Record<LinhaInput, number>>;
export type DerivadasResult = { receita_liquida: number; lucro_bruto: number; resultado_operacional: number; resultado_antes_impostos: number; resultado_liquido: number };

/**
 * Retorna a lista de meses fechados (com dados completos) para um dado ano.
 * - Ano passado: [1..12]
 * - Ano corrente: [1..mesAtual-1] (mês em curso fica fora)
 * - Ano futuro: []
 */
export function mesesFechados(ano: number, hoje: Date = new Date()): number[] {
  const anoAtual = hoje.getFullYear();
  if (ano < anoAtual) {
    return [1,2,3,4,5,6,7,8,9,10,11,12];
  }
  if (ano > anoAtual) {
    return [];
  }
  // ano === anoAtual: getMonth() é 0-based, então maio = 4 → fechados = [1,2,3,4]
  const mesCorrente = hoje.getMonth(); // 0-based: jan=0, mai=4
  return Array.from({ length: mesCorrente }, (_, i) => i + 1);
}

/**
 * Razão YTD: Σnum / Σden.
 * Retorna null se Σden <= 0 ou se arrays vazios.
 */
export function razaoYTD(num: number[], den: number[]): number | null {
  const s = den.reduce((acc, v) => acc + v, 0);
  if (s <= 0) return null;
  const n = num.reduce((acc, v) => acc + v, 0);
  return n / s;
}

/**
 * Fator de tendência YTD: Σreceita_bruta(atual) / Σreceita_bruta(anoAnt),
 * apenas nos meses em `fechados`, com cap [0.5, 2.0].
 * Retorna null se a base do ano anterior for <= 0.
 */
export function fatorTendenciaYTD(
  atual: MesDRE[],
  anoAnt: MesDRE[],
  fechados: number[]
): number | null {
  const fechadosSet = new Set(fechados);

  const somaAtual = atual
    .filter(m => fechadosSet.has(m.mes))
    .reduce((acc, m) => acc + (m.receita_bruta ?? 0), 0);

  const somaAnt = anoAnt
    .filter(m => fechadosSet.has(m.mes))
    .reduce((acc, m) => acc + (m.receita_bruta ?? 0), 0);

  if (somaAnt <= 0) return null;

  return Math.min(2.0, Math.max(0.5, somaAtual / somaAnt));
}

// ─── Task 2: projetarDRE ──────────────────────────────────────────────────────

type MetodoForecast =
  | 'sazonal_ajustado'
  | 'run_rate'
  | 'driver_receita'
  | 'media_movel'
  | 'razao_ytd_imposto'
  | 'orcado_remanescente'
  | 'sem_forecast';

type ForecastLinha = {
  dre_linha: string;
  realizado_fechado: number;
  forecast_restante: number;
  landing: number;
  orcado_ano: number | null;
  variancia: number | null;
  favoravel: boolean | null;
  fura_meta: boolean;
  metodo: MetodoForecast;
  confianca: 'alta' | 'media' | 'baixa';
  flags: string[];
};

export type ForecastResult = {
  company: string;
  ano: number;
  meses_fechados: number;
  linhas: ForecastLinha[];
  confianca_geral: 'alta' | 'media' | 'baixa';
  motivos: string[];
};

/** Helper interno: média dos últimos N valores de um array (ou todos se array.length < N) */
function mediaMeses(valores: number[], n: number): number {
  if (valores.length === 0) return 0;
  const slice = valores.slice(-n);
  return slice.reduce((acc, v) => acc + v, 0) / slice.length;
}

/** Helper interno: run-rate = média simples de um array */
function runRate(valores: number[]): number {
  if (valores.length === 0) return 0;
  return valores.reduce((acc, v) => acc + v, 0) / valores.length;
}

/** Helper interno: soma o orcado de uma linha (null se chave ausente ou todos null) */
function orcadoAno(
  orcado: Partial<Record<LinhaInput, (number | null)[]>>,
  linha: LinhaInput
): number | null {
  const arr = orcado[linha];
  if (!arr) return null;
  if (arr.every(v => v === null)) return null;
  return arr.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}

export function projetarDRE(input: {
  company: string;
  ano: number;
  hoje?: Date;
  dreAtual: MesDRE[];
  dreAnoAnterior: MesDRE[];
  orcado: Partial<Record<LinhaInput, (number | null)[]>>;
  pisoFuraMeta?: number;
}): ForecastResult {
  const { company, ano, dreAtual, dreAnoAnterior, orcado } = input;
  const hoje = input.hoje ?? new Date();
  const piso = input.pisoFuraMeta ?? 5000;

  const fechados = mesesFechados(ano, hoje);
  const fechadosSet = new Set(fechados);
  const todosOsMeses = [1,2,3,4,5,6,7,8,9,10,11,12];
  const restantes = todosOsMeses.filter(m => !fechadosSet.has(m));

  // ── Caso especial: 0 meses fechados ──────────────────────────────────────
  if (fechados.length === 0) {
    const TODAS_LINHAS_INPUT = [...LINHAS_INPUT] as LinhaInput[];
    const DERIVADAS = ['receita_liquida','lucro_bruto','resultado_operacional','resultado_antes_impostos','resultado_liquido'] as const;

    const linhas: ForecastLinha[] = [
      ...TODAS_LINHAS_INPUT.map((l): ForecastLinha => ({
        dre_linha: l,
        realizado_fechado: 0,
        forecast_restante: 0,
        landing: 0,
        orcado_ano: orcadoAno(orcado, l),
        variancia: null,
        favoravel: null,
        fura_meta: false,
        metodo: 'sem_forecast',
        confianca: 'baixa',
        flags: [],
      })),
      ...DERIVADAS.map((l): ForecastLinha => ({
        dre_linha: l,
        realizado_fechado: 0,
        forecast_restante: 0,
        landing: 0,
        orcado_ano: null,
        variancia: null,
        favoravel: null,
        fura_meta: false,
        metodo: 'sem_forecast',
        confianca: 'baixa',
        flags: [],
      })),
    ];

    return {
      company,
      ano,
      meses_fechados: 0,
      linhas,
      confianca_geral: 'baixa',
      motivos: ['Aguardando o 1º mês fechado para projetar.'],
    };
  }

  // ── Helpers para acessar DRE por mês ────────────────────────────────────
  const dreAtualPorMes = new Map<number, MesDRE>(dreAtual.map(m => [m.mes, m]));
  const dreAntPorMes = new Map<number, MesDRE>(dreAnoAnterior.map(m => [m.mes, m]));

  /** Valor de uma linha num mês do DRE atual (0 se ausente) */
  const valAtual = (mes: number, l: LinhaInput): number => dreAtualPorMes.get(mes)?.[l] ?? 0;

  /** Array de valores de uma linha nos meses fechados */
  const valoresFechados = (l: LinhaInput): number[] => fechados.map(m => valAtual(m, l));

  // ── Primitivas globais ───────────────────────────────────────────────────
  const fator = fatorTendenciaYTD(dreAtual, dreAnoAnterior, fechados);
  const recBrutaFechados = valoresFechados('receita_bruta');
  const deducoesFechados = valoresFechados('deducoes');
  const recLiqFechados = fechados.map(m => valAtual(m, 'receita_bruta') - valAtual(m, 'deducoes'));
  const cmvFechados = valoresFechados('cmv');

  // ── Forecast por mês (na ordem topológica) ──────────────────────────────
  // Armazenamos o forecast de cada linha por mês restante
  const fcPorMes: Record<LinhaInput, number[]> = {} as Record<LinhaInput, number[]>;
  const metodoPorLinha: Record<LinhaInput, MetodoForecast> = {} as Record<LinhaInput, MetodoForecast>;
  const flagsPorLinha: Record<LinhaInput, string[]> = {} as Record<LinhaInput, string[]>;

  for (const l of LINHAS_INPUT) {
    fcPorMes[l] = [];
    metodoPorLinha[l] = 'run_rate';
    flagsPorLinha[l] = [];
  }

  // a) receita_bruta: sazonal_ajustado / run_rate / orcado_remanescente
  const rrReceita = runRate(recBrutaFechados);
  const recBrutaFC: number[] = [];
  let metodoRecBruta: MetodoForecast = 'run_rate';

  if (fator !== null) {
    if (dreAnoAnterior.length > 0) {
      // sazonal: ano-1[mes] × fator. ⚠️ Se o ano anterior é ESPARSO (mês ausente/zero), NÃO zera o
      // forecast — cai pra run-rate naquele mês (Codex P1.3); senão receita/ded/cmv/imposto zerariam.
      for (const m of restantes) {
        const baseAnt = dreAntPorMes.get(m)?.receita_bruta;
        recBrutaFC.push(baseAnt != null && baseAnt > 0 ? baseAnt * fator : rrReceita);
      }
      metodoRecBruta = 'sazonal_ajustado';
    } else {
      // fator existe mas não há ano anterior → run-rate
      for (const _m of restantes) recBrutaFC.push(rrReceita);
      metodoRecBruta = 'run_rate';
    }
  } else if (fechados.length >= 1) {
    // run-rate
    for (const _m of restantes) recBrutaFC.push(rrReceita);
    metodoRecBruta = 'run_rate';
  } else {
    // fallback orcado (nunca chega aqui pois fechados.length=0 foi tratado acima)
    for (const m of restantes) {
      recBrutaFC.push(orcado.receita_bruta?.[m - 1] ?? 0);
    }
    metodoRecBruta = 'orcado_remanescente';
  }
  fcPorMes['receita_bruta'] = recBrutaFC;
  metodoPorLinha['receita_bruta'] = metodoRecBruta;

  // b) deducoes: driver razaoYTD(ded/receita_bruta) ou run-rate + flag
  const rDed = razaoYTD(deducoesFechados, recBrutaFechados);
  const deducoesFC: number[] = [];
  let metodoDed: MetodoForecast;
  if (rDed !== null) {
    for (let i = 0; i < restantes.length; i++) deducoesFC.push(rDed * recBrutaFC[i]);
    metodoDed = 'driver_receita';
  } else {
    const rrDed = runRate(deducoesFechados);
    for (const _m of restantes) deducoesFC.push(rrDed);
    metodoDed = 'run_rate';
    flagsPorLinha['deducoes'].push('denominador_zero');
  }
  fcPorMes['deducoes'] = deducoesFC;
  metodoPorLinha['deducoes'] = metodoDed;

  // c) receita_liquida_FC (calc intermediário, não é linha de output separada)
  const recLiqFC: number[] = recBrutaFC.map((rb, i) => rb - deducoesFC[i]);

  // d) cmv: driver razaoYTD(cmv/receita_liquida) ou run-rate + flag
  const rCmv = razaoYTD(cmvFechados, recLiqFechados);
  const cmvFC: number[] = [];
  let metodoCmv: MetodoForecast;
  if (rCmv !== null) {
    for (let i = 0; i < restantes.length; i++) cmvFC.push(rCmv * recLiqFC[i]);
    metodoCmv = 'driver_receita';
  } else {
    const rrCmv = runRate(cmvFechados);
    for (const _m of restantes) cmvFC.push(rrCmv);
    metodoCmv = 'run_rate';
    flagsPorLinha['cmv'].push('denominador_zero');
  }
  fcPorMes['cmv'] = cmvFC;
  metodoPorLinha['cmv'] = metodoCmv;

  // e) LINHAS_DESPESA_FIXA + outras_receitas + outras_despesas: run-rate
  const linhasRunRate: LinhaInput[] = [
    'despesas_operacionais', 'despesas_administrativas', 'despesas_comerciais',
    'outras_receitas', 'outras_despesas',
  ];
  for (const l of linhasRunRate) {
    const rr = runRate(valoresFechados(l));
    fcPorMes[l] = restantes.map(() => rr);
    metodoPorLinha[l] = 'run_rate';
  }

  // f) LINHAS_FINANCEIRA: média dos últimos 3 meses fechados
  const linhasFinanceira: LinhaInput[] = ['receitas_financeiras', 'despesas_financeiras'];
  for (const l of linhasFinanceira) {
    const vals = valoresFechados(l);
    const media = mediaMeses(vals, 3);
    fcPorMes[l] = restantes.map(() => media);
    metodoPorLinha[l] = 'media_movel';
  }

  // g) impostos: razaoYTD(impostos/receita_bruta) ou run-rate + flag
  const impostosFechados = valoresFechados('impostos');
  const rImp = razaoYTD(impostosFechados, recBrutaFechados);
  const impostosFC: number[] = [];
  let metodoImp: MetodoForecast;
  if (rImp !== null) {
    for (let i = 0; i < restantes.length; i++) impostosFC.push(rImp * recBrutaFC[i]);
    metodoImp = 'razao_ytd_imposto';
  } else {
    const rrImp = runRate(impostosFechados);
    for (const _m of restantes) impostosFC.push(rrImp);
    metodoImp = 'run_rate';
    flagsPorLinha['impostos'].push('denominador_zero');
  }
  fcPorMes['impostos'] = impostosFC;
  metodoPorLinha['impostos'] = metodoImp;

  // ── Agrega: realizado_fechado e forecast_restante por linha-input ────────
  const realizadoFechado: Partial<Record<LinhaInput, number>> = {};
  const forecastRestante: Partial<Record<LinhaInput, number>> = {};
  const landingInput: Partial<Record<LinhaInput, number>> = {};

  for (const l of LINHAS_INPUT) {
    realizadoFechado[l] = valoresFechados(l).reduce((acc, v) => acc + v, 0);
    forecastRestante[l] = (fcPorMes[l] ?? []).reduce((acc, v) => acc + v, 0);
    landingInput[l] = (realizadoFechado[l] ?? 0) + (forecastRestante[l] ?? 0);
  }

  // ── Confiança por linha-input ────────────────────────────────────────────
  const linhasVariaveis = new Set<LinhaInput>(['receita_bruta', 'cmv', 'despesas_comerciais', 'impostos']);

  function confiancaLinha(l: LinhaInput): 'alta' | 'media' | 'baixa' {
    const flags = flagsPorLinha[l] ?? [];
    if (flags.includes('denominador_zero')) return 'baixa';
    if (fechados.length < 3 && linhasVariaveis.has(l)) return 'baixa';
    // sazonal indisponível → run-rate (sem ano anterior ou sem fator)
    if (l === 'receita_bruta' && metodoPorLinha[l] === 'run_rate') return 'media';
    return 'alta';
  }

  // ── Variância e fura_meta ────────────────────────────────────────────────
  function calcVariancia(landing: number, oAno: number | null): number | null {
    if (oAno === null) return null;
    return landing - oAno;
  }

  function calcFavoravel(l: string, variancia: number | null): boolean | null {
    if (variancia === null) return null;
    const isReceita = LINHAS_RECEITA.has(l) || LINHAS_DERIV_FAVORAVEL_CIMA.has(l);
    return isReceita ? variancia >= 0 : variancia <= 0;
  }

  function calcFuraMeta(variancia: number | null, oAno: number | null): boolean {
    if (variancia === null) return false;
    const threshold = (oAno !== null && oAno > 0) ? Math.max(0.10 * oAno, piso) : piso;
    return Math.abs(variancia) > threshold;
  }

  // ── Monta linhas de input ────────────────────────────────────────────────
  const linhasInput: ForecastLinha[] = LINHAS_INPUT.map(l => {
    const real = realizadoFechado[l] ?? 0;
    const fc = forecastRestante[l] ?? 0;
    const landing = real + fc;
    const oAno = orcadoAno(orcado, l);
    const variancia = calcVariancia(landing, oAno);
    const favoravel = calcFavoravel(l, variancia);
    return {
      dre_linha: l,
      realizado_fechado: real,
      forecast_restante: fc,
      landing,
      orcado_ano: oAno,
      variancia,
      favoravel,
      fura_meta: calcFuraMeta(variancia, oAno),
      metodo: metodoPorLinha[l],
      confianca: confiancaLinha(l),
      flags: flagsPorLinha[l] ?? [],
    };
  });

  // ── Derivadas ────────────────────────────────────────────────────────────
  // Landing das derivadas via derivarLinhas sobre os landings dos inputs
  const derivLanding = derivarLinhas(
    Object.fromEntries(LINHAS_INPUT.map(l => [l, landingInput[l] ?? 0])) as Record<LinhaInput, number>
  );

  // orcado_ano das derivadas via derivarLinhas sobre os orcado_ano (null→0).
  // algumInputNullOrcado: algum input sem orçado (→ flag orcado_incompleto, mas computa com 0).
  // algumInputComOrcado: ao menos um input orçado (→ vale derivar; se NENHUM, o orçado derivado é null).
  const inputsOrcado: Partial<Record<LinhaInput, number>> = {};
  let algumInputNullOrcado = false;
  let algumInputComOrcado = false;
  for (const l of LINHAS_INPUT) {
    const v = orcadoAno(orcado, l);
    if (v === null) algumInputNullOrcado = true;
    else algumInputComOrcado = true;
    inputsOrcado[l] = v ?? 0;
  }
  const derivOrcado = derivarLinhas(inputsOrcado as Record<LinhaInput, number>);

  type DerivaKey = keyof typeof derivLanding;
  const DERIVADAS_KEYS: DerivaKey[] = [
    'receita_liquida', 'lucro_bruto', 'resultado_operacional',
    'resultado_antes_impostos', 'resultado_liquido',
  ];

  // Confiança das derivadas: pior dos inputs (simplificado: pior confiança das linhas-input)
  function piorConfianca(confs: Array<'alta' | 'media' | 'baixa'>): 'alta' | 'media' | 'baixa' {
    if (confs.includes('baixa')) return 'baixa';
    if (confs.includes('media')) return 'media';
    return 'alta';
  }
  const confTodasInputs = linhasInput.map(l => l.confianca);

  const linhasDerivadas: ForecastLinha[] = DERIVADAS_KEYS.map(l => {
    const landing = derivLanding[l];
    // orcado_ano da derivada: só null se NENHUM input tiver orçado (nada a comparar). Se ao menos um
    // input tem orçado, calcula (inputs ausentes = 0) e FLAG 'orcado_incompleto' — não some a variância
    // só porque uma linha não-relacionada ficou sem orçar (Codex P1.2).
    const oAno = algumInputComOrcado ? derivOrcado[l] : null;
    const flags: string[] = (algumInputComOrcado && algumInputNullOrcado) ? ['orcado_incompleto'] : [];
    const variancia = calcVariancia(landing, oAno);
    const favoravel = calcFavoravel(l, variancia);
    return {
      dre_linha: l,
      realizado_fechado: 0, // derivada não tem realizado próprio
      forecast_restante: 0, // derivada não tem forecast próprio
      landing,
      orcado_ano: oAno,
      variancia,
      favoravel,
      fura_meta: calcFuraMeta(variancia, oAno),
      metodo: 'sem_forecast' as MetodoForecast,
      confianca: piorConfianca(confTodasInputs),
      flags,
    };
  });

  const todasLinhas = [...linhasInput, ...linhasDerivadas];

  // ── confianca_geral ───────────────────────────────────────────────────────
  const linhasComOrcado = todasLinhas.filter(l => l.orcado_ano !== null);
  const confiancaGeral: 'alta' | 'media' | 'baixa' =
    linhasComOrcado.length === 0
      ? 'baixa'
      : piorConfianca(linhasComOrcado.map(l => l.confianca));

  return {
    company,
    ano,
    meses_fechados: fechados.length,
    linhas: todasLinhas,
    confianca_geral: confiancaGeral,
    motivos: [],
  };
}

// ─── Task 1 (sub-PR B): seedOrcamento ────────────────────────────────────────

/** Arredonda para 2 casas decimais (half-up, neutralizando erro de ponto flutuante). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Calcula a mediana de um array de números não-vazios. */
function mediana(vals: number[]): number {
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

type SeedFlag = 'winsorizado' | 'amostra_curta_sem_sugestao' | 'mes_ausente_media';
export type SeedLinha = { dre_linha: string; mes: number; valor_sugerido: number | null; flag?: SeedFlag };

/**
 * Sugere o orçamento do próximo ano: realizado do ano anterior × (1 + crescimento),
 * winsorizando outliers por múltiplo da mediana.
 * Emite 12 SeedLinha (mes 1..12) para cada linha de LINHAS_INPUT.
 * - amostra_curta_sem_sugestao: menos de 3 meses com valor ≠ 0 → valor_sugerido null.
 * - winsorizado: o valor foi capado pelo múltiplo da mediana.
 * - mes_ausente_media: mês sem dado → usa mediaCap ponderada.
 */
export function seedOrcamento(input: {
  dreBase: MesDRE[];
  crescimentoPerc: number;
  fatorOutlier?: number;
}): SeedLinha[] {
  const { dreBase } = input;
  // Guardas (Codex): crescimento NaN→0, piso -100 (orçamento nunca negativo); fatorOutlier ≥1 finito senão 3.
  const crescimentoPerc = Number.isFinite(input.crescimentoPerc) ? Math.max(-100, input.crescimentoPerc) : 0;
  const fatorOutlier = (Number.isFinite(input.fatorOutlier) && (input.fatorOutlier as number) >= 1) ? (input.fatorOutlier as number) : 3;
  const g = 1 + crescimentoPerc / 100;
  const resultado: SeedLinha[] = [];

  for (const linha of LINHAS_INPUT) {
    // Passo 1: valor de cada mês 1..12
    const v: Record<number, number> = {};
    for (let mes = 1; mes <= 12; mes++) {
      v[mes] = dreBase.find(d => d.mes === mes)?.[linha] ?? 0;
    }

    // Passo 2: meses com valor MATERIAL (Codex): v≠0 E ≥ 1% do pico da linha. Sem o corte de
    // materialidade, centavos residuais (ex.: [100000, 0,01, 0,01]) contam como amostra e arrastam a
    // mediana p/ ~0, capando o mês real de 100k pra ~0,03 (orçamento absurdamente subestimado).
    const mesesNaoZero = [1,2,3,4,5,6,7,8,9,10,11,12].filter(m => v[m] !== 0);
    const maxAbs = mesesNaoZero.length ? Math.max(...mesesNaoZero.map(m => Math.abs(v[m]))) : 0;
    const materialidade = maxAbs * 0.01;
    const mesesComValor = mesesNaoZero.filter(m => Math.abs(v[m]) >= materialidade);

    if (mesesComValor.length < 3) {
      // Amostra curta — sem sugestão
      for (let mes = 1; mes <= 12; mes++) {
        resultado.push({ dre_linha: linha, mes, valor_sugerido: null, flag: 'amostra_curta_sem_sugestao' });
      }
      continue;
    }

    // Passo 3: Winsorize por múltiplo da mediana
    const med = mediana(mesesComValor.map(m => v[m]));
    const capSup = med * fatorOutlier;
    const capInf = med / fatorOutlier;

    const vCap: Record<number, number> = {};
    const capou: Record<number, boolean> = {};
    for (const mes of mesesComValor) {
      const capped = Math.min(capSup, Math.max(capInf, v[mes]));
      vCap[mes] = capped;
      capou[mes] = capped !== v[mes];
    }

    // Passo 4: mediaCap (média dos vCap dos mesesComValor)
    const mediaCap = mesesComValor.reduce((acc, m) => acc + vCap[m], 0) / mesesComValor.length;

    // Passo 5: emite 12 SeedLinha
    const mesesComValorSet = new Set(mesesComValor);
    for (let mes = 1; mes <= 12; mes++) {
      if (mesesComValorSet.has(mes)) {
        const sugestao = round2(vCap[mes] * g);
        const entry: SeedLinha = { dre_linha: linha, mes, valor_sugerido: sugestao };
        if (capou[mes]) entry.flag = 'winsorizado';
        resultado.push(entry);
      } else {
        resultado.push({ dre_linha: linha, mes, valor_sugerido: round2(mediaCap * g), flag: 'mes_ausente_media' });
      }
    }
  }

  return resultado;
}

/**
 * Deriva as linhas calculadas do DRE a partir das linhas de input.
 * Campos omitidos são tratados como 0.
 */
export function derivarLinhas(i: Partial<Record<LinhaInput, number>>): DerivadasResult {
  const receita_bruta          = i.receita_bruta          ?? 0;
  const deducoes               = i.deducoes               ?? 0;
  const cmv                    = i.cmv                    ?? 0;
  const despesas_operacionais  = i.despesas_operacionais  ?? 0;
  const despesas_administrativas = i.despesas_administrativas ?? 0;
  const despesas_comerciais    = i.despesas_comerciais    ?? 0;
  const receitas_financeiras   = i.receitas_financeiras   ?? 0;
  const despesas_financeiras   = i.despesas_financeiras   ?? 0;
  const outras_receitas        = i.outras_receitas        ?? 0;
  const outras_despesas        = i.outras_despesas        ?? 0;
  const impostos               = i.impostos               ?? 0;

  const receita_liquida           = receita_bruta - deducoes;
  const lucro_bruto               = receita_liquida - cmv;
  // Fórmula IDÊNTICA ao DRE v2 oficial (dre-helpers.ts): financeiras entram no RESULTADO OPERACIONAL;
  // resultado_antes_impostos só soma outras_receitas/despesas (Codex P1.1 — manter consistente com o realizado).
  const resultado_operacional     = lucro_bruto - despesas_operacionais - despesas_administrativas - despesas_comerciais + receitas_financeiras - despesas_financeiras;
  const resultado_antes_impostos  = resultado_operacional + outras_receitas - outras_despesas;
  const resultado_liquido         = resultado_antes_impostos - impostos;

  return {
    receita_liquida,
    lucro_bruto,
    resultado_operacional,
    resultado_antes_impostos,
    resultado_liquido,
  };
}
