// src/lib/financeiro/ponto-equilibrio-helpers.ts
// F3 — Ponto de equilíbrio operacional na DRE (PEGN erro 7). Helper PURO (vitest).
// Overlay sobre fin_dre_snapshots.detalhamento (keyed por omie_codigo) + uma classificação
// fixo/variável/misto/nao_operacional declarada. NÃO reescreve montarDRE (espelhado no edge) —
// só LÊ o snapshot. Money-path: precisão > recall — degrada honesto (motivo, sem número) quando
// o dado não permite; NUNCA um PE otimista fabricado.
// Decisão Claude+Codex. Spec: docs/superpowers/specs/2026-07-04-ponto-equilibrio-dre-design.md.

export type TipoCusto = 'fixo' | 'variavel' | 'misto' | 'nao_operacional';

/** Um mês do snapshot de DRE (competência). `despesas` = detalhamento.despesas keyed por omie_codigo. */
export interface MesDRE {
  ano: number;
  mes: number;
  receita_bruta: number;
  deducoes_col: number; // coluna `deducoes` do snapshot (0 na OBEN — impostos moram no balde despesas)
  despesas: Record<string, number>; // omie_codigo → R$
  // Linhas oficiais da DRE — SÓ para reconciliação (§6). Não entram no cálculo do PE.
  linha_cmv: number;
  linha_operacionais: number;
  linha_administrativas: number;
  linha_comerciais: number;
  linha_financeiras: number;
}

export type MotivoPE =
  | 'ok'
  | 'sem_dados'
  | 'sem_receita'
  | 'mc_negativa'
  | 'inconclusivo'
  | 'custo_misto_material'
  | 'snapshot_inconsistente'
  | 'mc_instavel'
  | 'deducoes_coluna_inesperada'
  | 'valor_negativo_inesperado'
  | 'custo_compartilhado_pendente' // F3 v2 — exige rateio e não foi lançado
  | 'custo_compartilhado_possivel_duplicidade'; // F3 v2 — folha já no snapshot da própria empresa

/** Custo fixo compartilhado lançado pelo master (parcela da folha de outra empresa do grupo). */
export interface CustoCompartilhado {
  valor_mensal: number; // custo mensal NORMALIZADO (anual÷12, c/ 13º/férias/encargos)
  origem: string; // empresa que paga hoje, ex 'colacor_sc' (disclosure)
  rotulo: string; // ex 'folha'
}

export interface PontoEquilibrioConfig {
  coberturaMin: number; // 0.95 — % mínimo do valor das despesas classificado
  materialDespesaPct: number; // 0.05 — limiar de materialidade sobre as despesas
  materialReceitaPct: number; // 0.02 — limiar de materialidade sobre a receita
  reconcTolRel: number; // 0.01 — tolerância relativa da reconciliação Σdespesas × linhas DRE
  deducoesTolRel: number; // 0.01 — deducoes_col/receita acima disto = coluna inesperada (double-count)
  mcInstavelCv: number; // 0.35 — coef. de variação da MC% mensal acima disto = instável
  valorNegTolRel: number; // 0.005 — |despesa negativa|/despesas acima disto = sinal suspeito
}

export const CONFIG_PE_PADRAO: PontoEquilibrioConfig = {
  coberturaMin: 0.95,
  materialDespesaPct: 0.05,
  materialReceitaPct: 0.02,
  reconcTolRel: 0.01,
  deducoesTolRel: 0.01,
  mcInstavelCv: 0.35,
  valorNegTolRel: 0.005,
};

export interface PontoEquilibrioResult {
  motivo: MotivoPE;
  pe_receita: number | null;
  mc_pct: number | null;
  custos_fixos: number | null;
  custos_variaveis: number | null;
  margem_seguranca_pct: number | null;
  cobertura_pct: number | null;
  receita_bruta_ttm: number | null;
  /** Total TTM classificado 'nao_operacional' (dívida/financiamento) — EXCLUÍDO do PE. Disclosure (delta-E3). */
  excluido_nao_operacional_ttm: number;
  /** O mesmo, só do mês mais recente — para o card mostrar "último mês R$ Y". */
  excluido_nao_operacional_recente: number;
  /** excluido_nao_operacional_ttm / Σdespesas_ttm — guard-rail de "balde de fuga" (delta-E4). */
  nao_operacional_share_pct: number;
  periodo_label: string | null;
  /** Total TTM do custo fixo compartilhado somado ao fixo (folha rateada). 0 quando ausente. */
  custo_compartilhado_ttm: number;
  /** Valor mensal lançado (0 se ausente). */
  custo_compartilhado_mensal: number;
  /** Empresa de origem do custo (disclosure), ex 'colacor_sc'. */
  custo_compartilhado_origem: string | null;
  /** Pendência de rateio SOB outra degradação (o card avisa "além disto, falta ratear"). C8. */
  custo_compartilhado_pendente_latente: boolean;
  /** Contrato C10: === (motivo==='ok'). false ⇒ pe_receita e margem_seguranca são null. */
  can_show_break_even: boolean;
  detalhes: string[];
}

export interface PontoEquilibrioInput {
  meses: MesDRE[];
  classificacao: Record<string, TipoCusto>;
  config?: Partial<PontoEquilibrioConfig>;
  custoCompartilhado?: CustoCompartilhado | null;
  exigeCustoCompartilhado?: boolean;
  /** Σ TTM dos códigos de folha achados no snapshot da PRÓPRIA empresa (sinal anti-duplicidade). */
  custoCompartilhadoNoSnapshotTtm?: number;
}

const MESES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const rotuloMes = (m: MesDRE) => `${MESES_ABREV[m.mes - 1] ?? '??'}/${m.ano}`;

/** Σ TTM dos valores cujo código começa com algum dos prefixos (sinal anti-duplicidade da folha). */
export function somaCodigosPorPrefixo(meses: MesDRE[], prefixos: string[]): number {
  let total = 0;
  for (const m of meses)
    for (const [cod, v] of Object.entries(m.despesas))
      if (Number.isFinite(v) && prefixos.some((p) => cod.startsWith(p))) total += v;
  return total;
}

export function pontoEquilibrio(input: PontoEquilibrioInput): PontoEquilibrioResult {
  const cfg = { ...CONFIG_PE_PADRAO, ...(input.config ?? {}) };
  const { classificacao } = input;
  const meses = [...input.meses].sort((a, b) => a.ano * 12 + a.mes - (b.ano * 12 + b.mes));
  const exige = input.exigeCustoCompartilhado === true;
  const rateio = input.custoCompartilhado ?? null;
  const rateioValido = rateio != null && Number.isFinite(rateio.valor_mensal) && rateio.valor_mensal >= 0;
  const rateioPendente = exige && !rateioValido;

  // Degradação: nula os campos do PE; preserva o contexto informativo (o card explica o porquê).
  const degradar = (motivo: MotivoPE, ctx?: Partial<PontoEquilibrioResult>): PontoEquilibrioResult => ({
    motivo,
    pe_receita: null,
    mc_pct: null,
    custos_fixos: null,
    custos_variaveis: null,
    margem_seguranca_pct: null,
    cobertura_pct: null,
    receita_bruta_ttm: null,
    excluido_nao_operacional_ttm: 0,
    excluido_nao_operacional_recente: 0,
    nao_operacional_share_pct: 0,
    periodo_label: null,
    custo_compartilhado_ttm: 0,
    custo_compartilhado_mensal: 0,
    custo_compartilhado_origem: null,
    // latente só quando a degradação NÃO é o próprio pendente (nem sem_dados).
    custo_compartilhado_pendente_latente:
      rateioPendente && motivo !== 'custo_compartilhado_pendente' && motivo !== 'sem_dados',
    can_show_break_even: false,
    detalhes: [],
    ...ctx,
  });

  if (meses.length === 0) return degradar('sem_dados');

  // ── Agrega TTM por categoria (materialidade é por-código) ───────────────────────────────────
  const porCodigo = new Map<string, number>();
  let receitaTTM = 0;
  let deducoesColTTM = 0;
  let negativosTTM = 0; // Σ das parcelas negativas (sinal — delta-E7)
  for (const m of meses) {
    receitaTTM += m.receita_bruta;
    deducoesColTTM += m.deducoes_col;
    for (const [cod, valor] of Object.entries(m.despesas)) {
      porCodigo.set(cod, (porCodigo.get(cod) ?? 0) + valor);
      if (valor < 0) negativosTTM += valor;
    }
  }

  let fixosTTM = 0;
  let variaveisTTM = 0;
  let naoOpTTM = 0;
  let naoClassTTM = 0;
  let despesasTTM = 0;
  let maxNaoClass = 0; // maior código não classificado (materialidade)
  let maxMisto = 0; // maior código 'misto' (materialidade)
  for (const [cod, valor] of porCodigo) {
    despesasTTM += valor;
    const tipo = classificacao[cod];
    if (tipo === 'fixo') fixosTTM += valor;
    else if (tipo === 'variavel') variaveisTTM += valor;
    else if (tipo === 'misto') maxMisto = Math.max(maxMisto, valor);
    else if (tipo === 'nao_operacional') naoOpTTM += valor;
    else {
      naoClassTTM += valor;
      maxNaoClass = Math.max(maxNaoClass, valor);
    }
  }

  const recente = meses[meses.length - 1];
  const naoOpRecente = Object.entries(recente.despesas).reduce(
    (s, [cod, v]) => s + (classificacao[cod] === 'nao_operacional' ? v : 0),
    0,
  );
  const cobertura = despesasTTM > 0 ? (despesasTTM - naoClassTTM) / despesasTTM : 1;
  const share = despesasTTM > 0 ? naoOpTTM / despesasTTM : 0;
  const label = `${rotuloMes(meses[0])}–${rotuloMes(recente)}`;
  // Contexto preservado em toda degradação (menos sem_dados): o card mostra período/cobertura/excluído.
  const ctx: Partial<PontoEquilibrioResult> = {
    receita_bruta_ttm: receitaTTM,
    cobertura_pct: cobertura,
    excluido_nao_operacional_ttm: naoOpTTM,
    excluido_nao_operacional_recente: naoOpRecente,
    nao_operacional_share_pct: share,
    periodo_label: label,
  };

  // ── Gates em precedência: integridade → precondição → classificação → economia ──────────────
  // 1. Sinal (delta-E7): despesa negativa material infla a margem por acidente.
  if (Math.abs(negativosTTM) > cfg.valorNegTolRel * Math.max(despesasTTM, 1))
    return degradar('valor_negativo_inesperado', ctx);

  // 2. Reconciliação fail-closed (§6): Σdespesas × linhas oficiais da DRE.
  const linhasTTM = meses.reduce(
    (s, m) =>
      s + m.linha_cmv + m.linha_operacionais + m.linha_administrativas + m.linha_comerciais + m.linha_financeiras,
    0,
  );
  const baseReconc = Math.max(Math.abs(linhasTTM), Math.abs(despesasTTM), 1);
  if (Math.abs(despesasTTM - linhasTTM) / baseReconc > cfg.reconcTolRel)
    return degradar('snapshot_inconsistente', ctx);

  // 3. Sem receita → PE indefinido.
  if (!(receitaTTM > 0)) return degradar('sem_receita', ctx);

  // 4. Double-count de deduções (delta-E5): o design pressupõe imposto no BALDE, não na coluna.
  if (deducoesColTTM / receitaTTM > cfg.deducoesTolRel) return degradar('deducoes_coluna_inesperada', ctx);

  // 5. Cobertura / código não classificado material → inconclusivo (P1-D4: não vira "fixo conservador").
  const materialDesp = cfg.materialDespesaPct * despesasTTM;
  const materialRec = cfg.materialReceitaPct * receitaTTM;
  if (cobertura < cfg.coberturaMin || maxNaoClass > materialDesp || maxNaoClass > materialRec)
    return degradar('inconclusivo', ctx);

  // 6. 'misto' material → custo_misto_material (não força mentira binária).
  if (maxMisto > materialDesp) return degradar('custo_misto_material', ctx);

  // 7. Economia. custos_variaveis = deducoes_col (0 na OBEN) + Σ variável; fixos EXCLUEM nao_operacional.
  const custosVariaveis = deducoesColTTM + variaveisTTM;
  const custosFixosBase = fixosTTM; // SEM a folha (fixo conhecido)
  const mcPct = (receitaTTM - custosVariaveis) / receitaTTM;
  if (!(mcPct > 0)) return degradar('mc_negativa', ctx);

  // 8. MC% instável (P1-D8): mede a base OPERACIONAL mês a mês (sem nao_operacional).
  const mcMensais = meses
    .filter((m) => m.receita_bruta > 0)
    .map((m) => {
      let varMes = m.deducoes_col;
      for (const [cod, v] of Object.entries(m.despesas)) if (classificacao[cod] === 'variavel') varMes += v;
      return (m.receita_bruta - varMes) / m.receita_bruta;
    });
  if (mcMensais.length >= 2) {
    const media = mcMensais.reduce((a, b) => a + b, 0) / mcMensais.length;
    const varc = mcMensais.reduce((a, b) => a + (b - media) ** 2, 0) / mcMensais.length;
    const cv = Math.abs(media) > 1e-9 ? Math.sqrt(varc) / Math.abs(media) : Infinity;
    if (cv > cfg.mcInstavelCv) return degradar('mc_instavel', ctx);
  }

  // ctx enriquecido: preserva mc_pct/custos_fixos(sem folha)/variaveis p/ o card do estado pendente (§5).
  const ctxEconomia: Partial<PontoEquilibrioResult> = {
    ...ctx,
    mc_pct: mcPct,
    custos_fixos: custosFixosBase,
    custos_variaveis: custosVariaveis,
  };

  // 9. Duplicidade (C1): folha já no snapshot da própria empresa → somar o rateio dobraria.
  const noSnapshotTTM = input.custoCompartilhadoNoSnapshotTtm ?? 0;
  if (exige && noSnapshotTTM > cfg.materialDespesaPct * despesasTTM)
    return degradar('custo_compartilhado_possivel_duplicidade', ctxEconomia);

  // 10. Pendente (B): exige rateio e não foi lançado → vela pe/margem (último gate).
  if (rateioPendente) return degradar('custo_compartilhado_pendente', ctxEconomia);

  // ── OK: soma o rateio ao fixo (aditivo, pós-reconciliação) ──────────────────────────────────
  const custoCompartilhadoTtm = rateioValido ? rateio!.valor_mensal * meses.length : 0;
  const custosFixos = custosFixosBase + custoCompartilhadoTtm;
  const peReceita = custosFixos / mcPct;
  const margemSeguranca = (receitaTTM - peReceita) / receitaTTM;
  return {
    motivo: 'ok',
    pe_receita: peReceita,
    mc_pct: mcPct,
    custos_fixos: custosFixos,
    custos_variaveis: custosVariaveis,
    margem_seguranca_pct: margemSeguranca,
    cobertura_pct: cobertura,
    receita_bruta_ttm: receitaTTM,
    excluido_nao_operacional_ttm: naoOpTTM,
    excluido_nao_operacional_recente: naoOpRecente,
    nao_operacional_share_pct: share,
    periodo_label: label,
    custo_compartilhado_ttm: custoCompartilhadoTtm,
    custo_compartilhado_mensal: rateioValido ? rateio!.valor_mensal : 0,
    custo_compartilhado_origem: rateioValido ? rateio!.origem : null,
    custo_compartilhado_pendente_latente: false,
    can_show_break_even: true,
    detalhes: [],
  };
}
