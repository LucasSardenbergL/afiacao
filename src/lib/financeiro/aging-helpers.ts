// Onda 2 — Curvas de cobrança por faixa de aging, calibradas POR EXPOSIÇÃO.
// Módulo puro (sem deps de runtime), espelhado verbatim no engine Deno
// supabase/functions/fin-cashflow-engine/index.ts.

export type Faixa = 'a_vencer' | '1-30' | '31-60' | '61-90' | '+90';

export type CurvaFaixa = {
  taxa_recebimento: number; // [0,1]
  lag_dias: number;         // média ponderada por R$ do atraso total (recebimento - vencimento)
  lag_mediana: number;
  exposicao: number;
  pago: number;
  aberto: number;
  confianca: 'alta' | 'baixa';
};

export type TituloHist = {
  valor_documento: number;
  valor_recebido: number;
  saldo: number;
  data_vencimento: string | null;
  // Baixa REAL derivada das movimentações (v_titulo_baixas) — NÃO a coluna base
  // data_recebimento (que o Omie deixa sempre NULL no LIST). null = título sem
  // movimento `mf` joinável → fica FORA da calibração de timing (degradação honesta).
  data_baixa_derivada: string | null;
  status_titulo: string;
};

// Liquidação por STATUS (sinal confiável que sempre temos), não pela data de baixa
// (que o Omie não retorna no LIST → era sempre NULL → taxa_recebimento confiantemente 0).
const STATUS_LIQUIDADO = ['RECEBIDO', 'LIQUIDADO', 'PAGO'];
export function statusLiquidado(status: string | null | undefined): boolean {
  return !!status && STATUS_LIQUIDADO.includes(status);
}

// Valor efetivamente recebido, robusto a valor_recebido NULL/0 no LIST do Omie:
// 1) valor_recebido se > 0; 2) valor_documento − saldo (quitado = saldo 0); 3) face.
// Só chamado para títulos liquidados-por-status → o fallback nunca vira 0 indevido.
export function valorPagoEfetivo(t: { valor_recebido: number; valor_documento: number; saldo: number }): number {
  if (t.valor_recebido > 0) return t.valor_recebido;
  const liq = t.valor_documento - t.saldo;
  if (liq > 0) return liq;
  return t.valor_documento;
}

// Cobertura mínima de baixa derivada POR EMPRESA p/ calibrar curvas empíricas.
// Abaixo disso (ex: colacor ~10%) o subconjunto com baixa é pequeno E provavelmente
// enviesado (recentes/bancários) → NENHUMA faixa vira 'alta'; cai no default (codex).
const COBERTURA_MIN_EMPRESA = 0.4;
// Mínimo de liquidados-com-data POR FAIXA p/ a faixa ser confiável (≠ viés de seleção,
// que o gate de empresa cobre; este cobre amostra pequena na faixa).
const MIN_LIQUIDADOS_COM_DATA = 5;

// Gate de confiança do prazo (PMR/PMP) pela cobertura de baixa derivada: abaixo de
// COBERTURA_MIN_EMPRESA o prazo vem de amostra não-representativa → null ("—").
// Mesma regra do getCapitalDeGiro client-side; espelhado no fin-cashflow-engine.
export function prazoComGate(
  valor: number | null | undefined,
  cobertura: number | null | undefined,
  min = COBERTURA_MIN_EMPRESA,
): number | null {
  return (cobertura ?? 0) >= min && valor != null ? Number(valor) : null;
}

// dias_cobertura do CAIXA OPERACIONAL PROJETADO (Fase 3 B2): saldo / saída diária média
// do horizonte (Σ saídas projetadas / horizon*7). saldo<=0 → 0 (crítico); sem base de
// saída → null ("sem base", NÃO 999/cobertura infinita — que desligava o alerta).
// Espelhado no fin-cashflow-engine.
export function diasCoberturaProjetado(
  saldoCc: number,
  saidasHorizonte: number,
  horizonWeeks: number,
): number | null {
  if (saldoCc <= 0) return 0;
  const saidaDiaria = saidasHorizonte / Math.max(1, horizonWeeks * 7);
  return saidaDiaria > 0.01 ? saldoCc / saidaDiaria : null;
}

const FAIXAS: Faixa[] = ['a_vencer', '1-30', '31-60', '61-90', '+90'];

const LAG_MAX: Record<Faixa, number> = {
  'a_vencer': 45, '1-30': 60, '31-60': 90, '61-90': 120, '+90': 365,
};

export const CURVA_DEFAULT: Record<Faixa, { taxa_recebimento: number; lag_dias: number }> = {
  'a_vencer': { taxa_recebimento: 0.98, lag_dias: 5 },
  '1-30':     { taxa_recebimento: 0.95, lag_dias: 20 },
  '31-60':    { taxa_recebimento: 0.90, lag_dias: 40 },
  '61-90':    { taxa_recebimento: 0.80, lag_dias: 70 },
  '+90':      { taxa_recebimento: 0.50, lag_dias: 150 },
};

export function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()) / 86400000,
  );
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

export function faixaAging(diasAtraso: number): Faixa {
  if (diasAtraso <= 0) return 'a_vencer';
  if (diasAtraso <= 30) return '1-30';
  if (diasAtraso <= 60) return '31-60';
  if (diasAtraso <= 90) return '61-90';
  return '+90';
}

export function mediaPonderada(itens: Array<{ valor: number; peso: number }>): number {
  const somaPeso = itens.reduce((s, i) => s + i.peso, 0);
  if (somaPeso <= 0) return 0;
  return itens.reduce((s, i) => s + i.valor * i.peso, 0) / somaPeso;
}

export function mediana(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Calibra as curvas de cobrança por faixa de aging.
 *
 * Liquidação = STATUS (não a data de baixa, que o Omie deixa NULL). O TIMING (faixa
 * em que pagou + lag) vem da baixa DERIVADA (v_titulo_baixas); título liquidado SEM
 * baixa derivada fica FORA da calibração (não dá pra bucketizar sem fabricar).
 *
 * Dois gates contra "confiantemente errado":
 *  - EMPRESA: cobertura de baixa derivada < coberturaMinEmpresa → nenhuma faixa 'alta'
 *    (subconjunto pequeno+enviesado, ex: colacor ~10%). Cai no CURVA_DEFAULT.
 *  - FAIXA: além de count/volume/concentração, exige pago>0 e countLiqData mínimo —
 *    senão a faixa cai no default (mata o antigo taxa_recebimento=0 com confiança alta).
 *
 * Denominador (exposicao) = liquidados-com-data + abertos; abertos não-pagos puxam a
 * taxa pra baixo (observação censurada, não invisível).
 */
export function calibrarCurvas(
  titulos: TituloHist[],
  hoje: string,
  minTitulos = 20,
  minVolume = 50000,
  minLiquidadosComData = MIN_LIQUIDADOS_COM_DATA,
  coberturaMinEmpresa = COBERTURA_MIN_EMPRESA,
): Record<Faixa, CurvaFaixa> {
  // Cobertura da empresa: fração dos liquidados-por-status que têm baixa derivada.
  let liqTotal = 0, liqComData = 0;
  for (const t of titulos) {
    if (statusLiquidado(t.status_titulo)) {
      liqTotal += 1;
      if (t.data_baixa_derivada) liqComData += 1;
    }
  }
  const coberturaEmpresa = liqTotal > 0 ? liqComData / liqTotal : 0;
  const empresaCalibravel = coberturaEmpresa >= coberturaMinEmpresa;

  const acc: Record<Faixa, {
    exposicao: number; pago: number; aberto: number; count: number; countLiqData: number;
    topValor: number; lags: Array<{ valor: number; peso: number }>; lagsRaw: number[];
  }> = Object.fromEntries(
    FAIXAS.map(f => [f, { exposicao: 0, pago: 0, aberto: 0, count: 0, countLiqData: 0, topValor: 0, lags: [], lagsRaw: [] }]),
  ) as unknown as Record<Faixa, {
    exposicao: number; pago: number; aberto: number; count: number; countLiqData: number;
    topValor: number; lags: Array<{ valor: number; peso: number }>; lagsRaw: number[];
  }>;

  for (const t of titulos) {
    if (!t.data_vencimento) continue;
    const liquidado = statusLiquidado(t.status_titulo);
    const temData = !!t.data_baixa_derivada;
    if (liquidado && temData) {
      // bucketiza por quão atrasado PAGOU (timing real da baixa derivada)
      const faixa = faixaAging(daysBetween(t.data_baixa_derivada!, t.data_vencimento));
      const a = acc[faixa];
      const pago = valorPagoEfetivo(t);
      a.exposicao += t.valor_documento;
      a.count += 1;
      a.countLiqData += 1;
      a.topValor = Math.max(a.topValor, t.valor_documento);
      a.pago += pago;
      const lag = Math.max(0, daysBetween(t.data_baixa_derivada!, t.data_vencimento));
      a.lags.push({ valor: lag, peso: pago });
      a.lagsRaw.push(lag);
    } else if (!liquidado) {
      // aberto: bucketiza por idade atual; entra só no denominador (não-pago)
      const faixa = faixaAging(daysBetween(hoje, t.data_vencimento));
      const a = acc[faixa];
      a.exposicao += t.valor_documento;
      a.count += 1;
      a.topValor = Math.max(a.topValor, t.valor_documento);
      a.aberto += t.saldo;
    }
    // liquidado && !temData → EXCLUÍDO (sabemos QUE pagou, não QUANDO; não fabrica faixa)
  }

  const out = {} as Record<Faixa, CurvaFaixa>;
  for (const f of FAIXAS) {
    const a = acc[f];
    const volOk = a.exposicao >= minVolume;
    const countOk = a.count >= minTitulos;
    const concentracaoOk = a.exposicao > 0 ? (a.topValor / a.exposicao) <= 0.6 : false;
    const liqDataOk = a.countLiqData >= minLiquidadosComData && a.pago > 0;
    const confiavel = empresaCalibravel && countOk && volOk && concentracaoOk && liqDataOk;
    if (confiavel) {
      out[f] = {
        taxa_recebimento: Math.min(1, Math.max(0, a.exposicao > 0 ? a.pago / a.exposicao : 0)),
        lag_dias: mediaPonderada(a.lags),
        lag_mediana: mediana(a.lagsRaw),
        exposicao: a.exposicao, pago: a.pago, aberto: a.aberto,
        confianca: 'alta',
      };
    } else {
      out[f] = {
        taxa_recebimento: CURVA_DEFAULT[f].taxa_recebimento,
        lag_dias: CURVA_DEFAULT[f].lag_dias,
        lag_mediana: CURVA_DEFAULT[f].lag_dias,
        exposicao: a.exposicao, pago: a.pago, aberto: a.aberto,
        confianca: 'baixa',
      };
    }
  }
  return out;
}

export function dataRecebimentoEsperada(input: {
  data_vencimento: string;
  hoje: string;
  faixa: Faixa;
  lag_dias_faixa: number;
  lag_residual_default?: number;
}): string {
  const residual = input.lag_residual_default ?? 15;
  if (input.faixa === 'a_vencer') {
    return addDays(input.data_vencimento, input.lag_dias_faixa);
  }
  const diasAtraso = daysBetween(input.hoje, input.data_vencimento);
  const lagRestante = input.lag_dias_faixa - diasAtraso;
  // Estimativa positiva = ainda dentro do lag esperado → usa ela.
  // Se já passou do lag esperado (≤0), usa residual pra não cair "hoje seco".
  return addDays(input.hoje, lagRestante > 0 ? lagRestante : residual);
}

export function aplicarCenarioCurva(
  curva: CurvaFaixa,
  faixa: Faixa,
  deltas: { recebimento_no_prazo_pct_delta: number; inadimplencia_pct_delta: number },
): CurvaFaixa {
  const perda = 1 - curva.taxa_recebimento;
  const perdaNova = perda * (1 + deltas.inadimplencia_pct_delta / 100);
  const taxa = Math.min(1, Math.max(0, 1 - perdaNova));
  const lagBruto = curva.lag_dias * (1 - deltas.recebimento_no_prazo_pct_delta / 100);
  const lag = Math.min(LAG_MAX[faixa], Math.max(0, lagBruto));
  return { ...curva, taxa_recebimento: taxa, lag_dias: lag };
}

export function inadimplenciaPonderada(
  crsAbertos: Array<{ saldo: number; faixa: Faixa }>,
  curvas: Record<Faixa, { taxa_recebimento: number }>,
): number {
  const itens = crsAbertos.map(c => ({ valor: 1 - curvas[c.faixa].taxa_recebimento, peso: c.saldo }));
  return mediaPonderada(itens) * 100;
}

export function prazoMedioPonderado(titulos: Array<{ dias: number; valor: number }>): number {
  return mediaPonderada(titulos.map(t => ({ valor: t.dias, peso: t.valor })));
}
