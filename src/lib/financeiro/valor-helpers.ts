// A2 — Retorno & Valor (ROIC/WACC/EVA). Módulo puro (sem deps de runtime),
// espelhado verbatim na edge function Deno supabase/functions/fin-valor-engine/index.ts.
// Correções pós-Codex (2026-05-23): NOPAT subtrai só impostos ABAIXO da linha (presumido: IRPJ+CSLL;
// simples: 0 — DAS já está nas deduções); EBIT operacional PURO (sem resultado financeiro); sem clamp.

import type { RegimeTributario } from './dre-helpers';

export type NopatInput = {
  regime: RegimeTributario;
  resultado_operacional_ttm: number;   // EBIT bruto da DRE (inclui +recfin −despfin)
  receitas_financeiras_ttm: number;
  despesas_financeiras_ttm: number;
  irpj_ttm: number;
  csll_ttm: number;
  // carga indireta já absorvida ACIMA do EBIT (só informacional, nunca re-subtraída):
  das_ttm: number;
  pis_ttm: number;
  cofins_ttm: number;
  icms_ttm: number;
  iss_ttm: number;
  ipi_ttm: number;
};

export type NopatResult = {
  ebit: number;
  imposto_operacional_nopat: number;
  nopat: number;
  carga_tributaria_regime_total: number;
};

export function calcularNOPAT(input: NopatInput): NopatResult {
  // EBIT operacional PURO: remove o resultado financeiro embutido no resultado_operacional da DRE.
  const ebit =
    input.resultado_operacional_ttm - input.receitas_financeiras_ttm + input.despesas_financeiras_ttm;
  // Só impostos ABAIXO da linha operacional. Indiretos (presumido) e DAS (simples) já saíram nas deduções.
  const imposto_operacional_nopat = input.regime === 'presumido' ? input.irpj_ttm + input.csll_ttm : 0;
  // Sem clamp: NOPAT pode ser negativo honestamente.
  const nopat = ebit - imposto_operacional_nopat;
  const carga_tributaria_regime_total =
    input.regime === 'simples'
      ? input.das_ttm
      : input.irpj_ttm + input.csll_ttm + input.pis_ttm + input.cofins_ttm + input.icms_ttm + input.iss_ttm + input.ipi_ttm;
  return { ebit, imposto_operacional_nopat, nopat, carga_tributaria_regime_total };
}

export function margemOperacionalPreImposto(input: { ebit: number; receita_liquida: number }): number {
  if (input.receita_liquida <= 0) return 0;
  return input.ebit / input.receita_liquida;
}

export type AtivoFixoInput = {
  valor: number;
  data_ref: string | null;
  fonte: 'book' | 'avaliacao' | 'reposicao' | 'seguro' | null;
  base: 'reposicao' | 'book' | null;
  operacional: boolean;
} | null;

export type CapitalInvestidoResult = {
  capital_investido: number | null;   // null quando giro indisponível (ausente ≠ R$0)
  capital_giro: number | null;
  ativo_fixo: number;
  ajustes: number;
  parcial: boolean;
  giro_indisponivel: boolean;          // capital de giro (NCG) não veio do snapshot
  motivos: string[];
};

export function capitalInvestido(input: {
  capital_giro: number | null;
  ativo_fixo: AtivoFixoInput;
  ajustes?: number;
}): CapitalInvestidoResult {
  const ajustes = input.ajustes ?? 0;
  const motivos: string[] = [];
  let ativo_fixo = 0;
  let parcial = false;
  const giro_indisponivel = input.capital_giro == null;
  if (input.ativo_fixo && input.ativo_fixo.operacional && Number.isFinite(input.ativo_fixo.valor)) {
    ativo_fixo = input.ativo_fixo.valor;
  } else {
    parcial = true;
    motivos.push('Ativo fixo operacional não informado — capital investido parcial (só giro − ajustes).');
  }
  // Giro ausente NÃO vira R$0: sem o NCG, o capital investido é indisponível (ROIC/EVA não calculáveis).
  if (giro_indisponivel) {
    motivos.push('Sem snapshot de NCG — capital de giro indisponível; ROIC/EVA não calculáveis.');
    return { capital_investido: null, capital_giro: null, ativo_fixo, ajustes, parcial: true, giro_indisponivel: true, motivos };
  }
  const capital_investido = (input.capital_giro as number) + ativo_fixo - ajustes;
  return { capital_investido, capital_giro: input.capital_giro, ativo_fixo, ajustes, parcial, giro_indisponivel: false, motivos };
}

// ===================== Resolução de capital de giro a partir dos snapshots da engine A1 =====================
export type SnapNcg = { ncg: number | null; snapshot_at: string };

// ncg pode chegar como número OU string numérica (PostgREST devolve `numeric` como string p/ preservar precisão).
// null / '' / whitespace / NaN / Infinity → AUSÊNCIA (NÃO vira 0 — `Number('')===0` seria fabricação). 0 e negativo são REAIS.
function ncgFinito(ncg: unknown): number | null {
  if (ncg == null) return null;
  if (typeof ncg === 'string' && ncg.trim() === '') return null;
  const n = Number(ncg);
  return Number.isFinite(n) ? n : null;
}

// Último snapshot com ncg válido. Não confia na ordem do array — pega o mais recente por data.
export function resolverCapitalGiro(snaps: SnapNcg[]): { capital_giro: number | null; snapshot_at: string | null; disponivel: boolean } {
  let melhor: { ncg: number; snapshot_at: string } | null = null;
  for (const s of snaps) {
    const n = ncgFinito(s.ncg);
    if (n == null) continue;
    if (melhor == null || Date.parse(s.snapshot_at) > Date.parse(melhor.snapshot_at)) melhor = { ncg: n, snapshot_at: s.snapshot_at };
  }
  if (melhor == null) return { capital_giro: null, snapshot_at: null, disponivel: false };
  return { capital_giro: melhor.ncg, snapshot_at: melhor.snapshot_at, disponivel: true };
}

// Frescor do NCG: cron de snapshot é diário → 45+ dias indica pipeline defasado. Stale NÃO vira
// indisponível (o NCG é real) — só rebaixa a confiança e fica visível. `hojeMs` injetado p/ testar puro.
export function frescorGiro(snapshot_at: string | null, hojeMs: number, limiarStaleDias = 45): { dias: number | null; stale: boolean } {
  if (!snapshot_at) return { dias: null, stale: false };
  const t = Date.parse(snapshot_at);
  if (!Number.isFinite(t)) return { dias: null, stale: false };
  const dias = Math.round((hojeMs - t) / 86400000);
  return { dias, stale: dias > limiarStaleDias };
}

// NCG ~365d antes do snapshot atual (ponto −12m do ROIC incremental), com tolerância.
export function acharCapitalGiroAnterior(snaps: SnapNcg[], refSnapshotAt: string, opts?: { janelaDias?: number; toleranciaDias?: number }): number | null {
  const janela = opts?.janelaDias ?? 365;
  const tol = opts?.toleranciaDias ?? 60;
  const alvo = Date.parse(refSnapshotAt) - janela * 86400000;
  let melhor: { ncg: number; dist: number } | null = null;
  for (const s of snaps) {
    const n = ncgFinito(s.ncg);
    if (n == null) continue;
    const dist = Math.abs(Date.parse(s.snapshot_at) - alvo);
    if (melhor == null || dist < melhor.dist) melhor = { ncg: n, dist };
  }
  return melhor && melhor.dist <= tol * 86400000 ? melhor.ncg : null;
}

// Orquestração pura do bloco de capital (resolver + frescor + anterior + capitalInvestido) — testável
// ponta-a-ponta e espelhada verbatim no edge. Defeita o "capital_giro = ncg ? ncg : 0" inline.
export function resolverCapitalParaValor(input: {
  snaps: SnapNcg[];
  ativo_fixo: AtivoFixoInput;
  ajustes?: number;
  hojeMs: number;
  limiarStaleDias?: number;
}): {
  capital: CapitalInvestidoResult;
  capital_anterior: number | null;
  giro_snapshot_at: string | null;
  giro_dias: number | null;
  giro_stale: boolean;
} {
  const giro = resolverCapitalGiro(input.snaps);
  const frescor = frescorGiro(giro.snapshot_at, input.hojeMs, input.limiarStaleDias);
  const capital = capitalInvestido({ capital_giro: giro.capital_giro, ativo_fixo: input.ativo_fixo, ajustes: input.ajustes });
  // Sem o ponto atual de giro, o incremental não existe (anterior forçado a null).
  const capital_giro_anterior = giro.disponivel && giro.snapshot_at
    ? acharCapitalGiroAnterior(input.snaps, giro.snapshot_at)
    : null;
  const capital_anterior = capital_giro_anterior != null
    ? capitalInvestido({ capital_giro: capital_giro_anterior, ativo_fixo: input.ativo_fixo, ajustes: input.ajustes }).capital_investido
    : null;
  return { capital, capital_anterior, giro_snapshot_at: giro.snapshot_at, giro_dias: frescor.dias, giro_stale: frescor.stale };
}

export type KeDecomposto = {
  ancora: number;
  premio_risco_equity: number;
  premio_tamanho_private: number;
  premio_iliquidez_controle: number;
};

export function somarKe(d: KeDecomposto): number {
  return d.ancora + d.premio_risco_equity + d.premio_tamanho_private + d.premio_iliquidez_controle;
}

export type WaccResult = {
  wacc: number | null;
  ke: number | null;
  kd: number | null;
  peso_divida: number | null;
  peso_equity: number | null;
  tax_shield_aplicado: false; // sempre false: tax-shield desligado por regime (Simples/Presumido)
  motivos: string[];
};

export function waccHurdle(input: {
  ke: number | null;
  kd: number | null;
  divida: number | null;
  equity: number | null;
}): WaccResult {
  const motivos: string[] = [];
  const base: WaccResult = {
    wacc: null, ke: input.ke, kd: input.kd, peso_divida: null, peso_equity: null,
    tax_shield_aplicado: false, motivos,
  };
  if (input.ke == null) { motivos.push('Ke não informado — WACC indisponível.'); return base; }
  if (input.equity == null) { motivos.push('PL (equity) não informado — WACC indisponível.'); return base; }
  if (input.divida == null) { motivos.push('Dívida não informada — WACC indisponível.'); return base; }
  const total = input.divida + input.equity;
  if (total <= 0) { motivos.push('Dívida + PL ≤ 0 — WACC indisponível.'); return base; }
  if (input.divida > 0 && input.kd == null) { motivos.push('Há dívida mas Kd não informado — WACC indisponível.'); return base; }
  const peso_divida = input.divida / total;
  const peso_equity = 1 - peso_divida;
  const kd = input.kd ?? 0;
  // Kd PRÉ-imposto: sem ×(1−t). Tax-shield ≈ 0 nos dois regimes.
  const wacc = peso_equity * input.ke + peso_divida * kd;
  return { wacc, ke: input.ke, kd: input.kd, peso_divida, peso_equity, tax_shield_aplicado: false, motivos };
}

export function roic(input: { nopat: number; capital_investido: number | null }): number | null {
  if (input.capital_investido == null || input.capital_investido <= 0) return null;
  return input.nopat / input.capital_investido;
}

export function spread(input: { roic: number | null; wacc: number | null }): number | null {
  if (input.roic == null || input.wacc == null) return null;
  return input.roic - input.wacc;
}

export function eva(input: { spread: number | null; capital_investido: number | null }): number | null {
  if (input.spread == null || input.capital_investido == null) return null;
  return input.spread * input.capital_investido;
}

export type RoicIncrementalResult = {
  roic_incremental: number | null;
  delta_nopat: number | null;
  delta_capital: number | null;
  aviso: string | null;
};

export function roicIncremental(input: {
  nopat_atual: number;
  nopat_anterior: number | null;
  capital_atual: number | null;
  capital_anterior: number | null;
  limiar_delta_capital?: number;
}): RoicIncrementalResult {
  const limiar = input.limiar_delta_capital ?? 1000;
  if (input.nopat_anterior == null || input.capital_atual == null || input.capital_anterior == null) {
    return {
      roic_incremental: null, delta_nopat: null, delta_capital: null,
      aviso: 'Histórico insuficiente (precisa de NOPAT e capital do TTM atual e do TTM −12m).',
    };
  }
  const delta_nopat = input.nopat_atual - input.nopat_anterior;
  const delta_capital = input.capital_atual - input.capital_anterior;
  if (delta_capital < limiar) {
    return {
      roic_incremental: null, delta_nopat, delta_capital,
      aviso: 'Variação de capital pequena ou negativa — ROIC incremental seria ruído.',
    };
  }
  return { roic_incremental: delta_nopat / delta_capital, delta_nopat, delta_capital, aviso: null };
}

export type CominglingResult = {
  ebit_reportado: number;
  ebit_normalizado: number;
  capital_reportado: number | null;
  capital_normalizado: number | null;
  ajuste_prolabore: number;
  ajuste_aluguel: number;
  ajuste_intercompany_capital: number;
  aplicado: boolean;
  motivos: string[];
};

export function normalizarComingling(input: {
  ebit_reportado: number;
  capital_reportado: number | null;
  prolabore_real_ttm: number | null;
  prolabore_mercado_ttm: number | null;
  aluguel_mercado_ttm: number | null;
  intercompany_giro: number | null;
}): CominglingResult {
  const motivos: string[] = [];
  let aplicado = false;

  // Pró-labore: EBIT reportado já deduziu o pró-labore REAL. Normalizar p/ mercado:
  // ebit_norm = ebit_rep + (real − mercado). Dono que se paga abaixo do mercado infla o lucro reportado.
  let ajuste_prolabore = 0;
  if (input.prolabore_real_ttm != null && input.prolabore_mercado_ttm != null) {
    ajuste_prolabore = input.prolabore_real_ttm - input.prolabore_mercado_ttm;
    aplicado = true;
  } else {
    motivos.push('Pró-labore real/mercado não informado — sem normalização de pró-labore.');
  }

  // Aluguel de mercado de ativos do dono usados sem cobrança: despesa figurativa → reduz EBIT.
  let ajuste_aluguel = 0;
  if (input.aluguel_mercado_ttm != null) {
    ajuste_aluguel = -input.aluguel_mercado_ttm;
    aplicado = true;
  } else {
    motivos.push('Aluguel de mercado não informado — sem normalização de aluguel.');
  }

  // Intercompany dentro do giro: removido do capital no normalizado.
  let ajuste_intercompany_capital = 0;
  if (input.intercompany_giro != null) {
    ajuste_intercompany_capital = -input.intercompany_giro;
    aplicado = true;
  }

  const ebit_normalizado = input.ebit_reportado + ajuste_prolabore + ajuste_aluguel;
  // Guard anti-coerção: capital_reportado null NÃO pode virar `null + ajuste` = número.
  const capital_normalizado = input.capital_reportado == null ? null : input.capital_reportado + ajuste_intercompany_capital;
  if (!aplicado) motivos.push('Sem inputs de normalização — só visão reportada; possível comingling do dono não ajustado.');

  return {
    ebit_reportado: input.ebit_reportado,
    ebit_normalizado,
    capital_reportado: input.capital_reportado,
    capital_normalizado,
    ajuste_prolabore,
    ajuste_aluguel,
    ajuste_intercompany_capital,
    aplicado,
    motivos,
  };
}

export type ConfiancaValor = {
  nivel: 'alta' | 'media' | 'baixa';
  motivos: string[];
  roic_disponivel: boolean;
  wacc_disponivel: boolean;
  eva_disponivel: boolean;
  normalizado_disponivel: boolean;
};

export function scoreConfiancaValor(input: {
  roic_null: boolean;
  wacc_null: boolean;
  eva_null: boolean;
  capital_parcial: boolean;
  normalizacao_aplicada: boolean;
  imposto_teorico_parcial: boolean;
  dre_confianca: 'alta' | 'media' | 'baixa';
  ttm_parcial?: boolean;   // janela TTM com < 12 meses de DRE (anualização parcial)
  giro_indisponivel?: boolean;  // sem snapshot de NCG → capital/ROIC/EVA indisponíveis (mais severo)
  giro_stale?: boolean;         // NCG real porém antigo → defasagem possível
}): ConfiancaValor {
  const motivos: string[] = [];
  let nivel = 3; // 3=alta, 2=media, 1=baixa — pega o pior sinal
  const rebaixar = (para: number, motivo: string) => { if (para < nivel) nivel = para; motivos.push(motivo); };

  if (input.ttm_parcial) rebaixar(2, 'TTM incompleto (menos de 12 meses de DRE) — anualização parcial.');
  // NCG ausente é o sinal mais severo (dado central de capital faltando) e domina o "(sem ativo fixo)".
  if (input.giro_indisponivel) {
    rebaixar(1, 'Sem snapshot de NCG — capital de giro indisponível; ROIC/EVA não calculáveis.');
  } else {
    if (input.giro_stale) rebaixar(2, 'NCG desatualizado (snapshot antigo) — capital de giro pode estar defasado.');
    if (input.capital_parcial) rebaixar(2, 'Capital investido parcial (sem ativo fixo) — ROIC/EVA parciais.');
  }
  if (input.wacc_null) rebaixar(2, 'WACC/EVA/spread indisponíveis (faltam dívida, PL ou Ke).');
  if (!input.normalizacao_aplicada) rebaixar(2, 'Sem normalização de comingling — só visão reportada.');
  if (input.imposto_teorico_parcial) rebaixar(2, 'Config tributária incompleta — imposto operacional parcial (propaga da Onda 3).');
  if (input.dre_confianca === 'baixa') rebaixar(1, 'DRE subjacente com confiança baixa.');
  else if (input.dre_confianca === 'media') rebaixar(2, 'DRE subjacente com confiança média.');
  // roic_null por capital ≤0 CONHECIDO (giro disponível) é media; quando o giro está indisponível já caiu pra baixa acima.
  if (input.roic_null && !input.giro_indisponivel) rebaixar(2, 'ROIC indisponível (capital investido ≤ 0).');

  return {
    nivel: nivel === 3 ? 'alta' : nivel === 2 ? 'media' : 'baixa',
    motivos,
    roic_disponivel: !input.roic_null,
    wacc_disponivel: !input.wacc_null,
    eva_disponivel: !input.eva_null,
    normalizado_disponivel: input.normalizacao_aplicada,
  };
}
