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
  /**
   * DRE fase 2 — detalhamento.composicao_despesas do PRÓPRIO snapshot: chave do `despesas` →
   * linha → R$. Presente ⇒ o PE usa só o que o motor pôs nas 5 linhas operacionais (fora_dre,
   * impostos e outras_despesas saem, expostos à parte). Ausente/null ⇒ snapshot pré-fase 2:
   * comportamento de antes, inclusive o gate 4.
   */
  composicao_despesas?: Record<string, Record<string, number>> | null;
  /** DRE fase 2 — true = composição fora_dre pendente: resultado do mês é provisório. */
  resultado_provisorio?: boolean | null;
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
  | 'custo_compartilhado_possivel_duplicidade' // F3 v2 — folha já no snapshot da própria empresa
  | 'resultado_provisorio'; // DRE fase 2 — mês com saída fora do DRE de composição pendente

/** Custo fixo compartilhado lançado pelo master (parcela da folha de outra empresa do grupo). */
export interface CustoCompartilhado {
  valor_mensal: number; // custo mensal NORMALIZADO (anual÷12, c/ 13º/férias/encargos)
  origem: string; // empresa que paga hoje, ex 'colacor_sc' (disclosure)
  rotulo: string; // ex 'folha'
}

interface PontoEquilibrioConfig {
  coberturaMin: number; // 0.95 — % mínimo do valor das despesas classificado
  materialDespesaPct: number; // 0.05 — limiar de materialidade sobre as despesas
  materialReceitaPct: number; // 0.02 — limiar de materialidade sobre a receita
  reconcTolRel: number; // 0.01 — tolerância relativa da reconciliação Σdespesas × linhas DRE
  deducoesTolRel: number; // 0.01 — deducoes_col/receita acima disto = coluna inesperada (double-count)
  mcInstavelCv: number; // 0.35 — coef. de variação da MC% mensal acima disto = instável
  valorNegTolRel: number; // 0.005 — |despesa negativa|/despesas acima disto = sinal suspeito
}

const CONFIG_PE_PADRAO: PontoEquilibrioConfig = {
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
  /** DRE fase 2 — TTM tirado do PE pela composição do snapshot (disclosure, não entra no PE). */
  excluido_fora_dre_ttm: number;
  excluido_deducoes_ttm: number; // ICMS/PIS/COFINS/2.09… do CP: já entram via deducoes_col
  excluido_imposto_lucro_ttm: number; // IRPJ/CSLL
  excluido_outras_ttm: number; // outras_despesas e qualquer linha fora das 5
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

const LINHAS_PE = ['cmv', 'despesas_operacionais', 'despesas_administrativas', 'despesas_comerciais', 'despesas_financeiras'] as const;
const LINHAS_DEDUCAO = new Set(['deducoes', 'ded_icms', 'ded_iss', 'ded_pis', 'ded_cofins', 'ded_ipi', 'das']);
const LINHAS_IMPOSTO_LUCRO = new Set(['irpj', 'csll']);
const TOL_COMPOSICAO = 0.01; // R$ — arredondamento de centavos

/**
 * Universo do PE de um mês fase 2: por chave, só o que o motor pôs nas 5 linhas. Devolve null
 * (⇒ snapshot_inconsistente) se a composição não fecha com `despesas` chave a chave, se falta
 * chave, se tem chave a mais, ou se a soma por linha não bate a coluna oficial daquele mês.
 */
export function universoOperacional(m: MesDRE): {
  despesas: Record<string, number>;
  excluido: { fora_dre: number; deducoes: number; imposto_lucro: number; outras: number };
} | null {
  const comp = m.composicao_despesas;
  if (comp == null || typeof comp !== 'object') return null;
  const chavesDesp = Object.keys(m.despesas);
  const chavesComp = Object.keys(comp);
  if (chavesDesp.length !== chavesComp.length) return null;
  const despesas: Record<string, number> = {};
  const excluido = { fora_dre: 0, deducoes: 0, imposto_lucro: 0, outras: 0 };
  const porLinha: Record<string, number> = {};
  for (const k of chavesDesp) {
    const linhas = comp[k];
    if (linhas == null || typeof linhas !== 'object') return null;
    let soma = 0;
    let operacional = 0;
    for (const [linha, v] of Object.entries(linhas)) {
      if (!Number.isFinite(v)) return null;
      soma += v;
      if ((LINHAS_PE as readonly string[]).includes(linha)) { operacional += v; porLinha[linha] = (porLinha[linha] ?? 0) + v; }
      else if (linha === 'fora_dre') excluido.fora_dre += v;
      else if (LINHAS_DEDUCAO.has(linha)) excluido.deducoes += v;
      else if (LINHAS_IMPOSTO_LUCRO.has(linha)) excluido.imposto_lucro += v;
      else excluido.outras += v;
    }
    if (Math.abs(soma - m.despesas[k]) > TOL_COMPOSICAO) return null;
    if (operacional !== 0) despesas[k] = operacional;
  }
  // por linha, no MÊS (erros de meses distintos podem se cancelar no TTM)
  const oficial: Record<string, number> = {
    cmv: m.linha_cmv, despesas_operacionais: m.linha_operacionais, despesas_administrativas: m.linha_administrativas,
    despesas_comerciais: m.linha_comerciais, despesas_financeiras: m.linha_financeiras,
  };
  for (const l of LINHAS_PE) {
    const a = porLinha[l] ?? 0;
    const b = oficial[l];
    if (Math.abs(a - b) > Math.max(TOL_COMPOSICAO, 0.01 * Math.max(Math.abs(a), Math.abs(b)))) return null;
  }
  return { despesas, excluido };
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
    excluido_fora_dre_ttm: 0,
    excluido_deducoes_ttm: 0,
    excluido_imposto_lucro_ttm: 0,
    excluido_outras_ttm: 0,
    // latente só quando a degradação NÃO é o próprio pendente (nem sem_dados).
    custo_compartilhado_pendente_latente:
      rateioPendente && motivo !== 'custo_compartilhado_pendente' && motivo !== 'sem_dados',
    can_show_break_even: false,
    detalhes: [],
    ...ctx,
  });

  if (meses.length === 0) return degradar('sem_dados');

  // ── DRE fase 2: universo do PE por mês, pela composição do PRÓPRIO snapshot ─────────────────
  // Nunca o mapa atual reinterpretando mês antigo. Composição incompleta/divergente ⇒ inconsistente.
  const excl = { fora_dre: 0, deducoes: 0, imposto_lucro: 0, outras: 0 };
  let composicaoInvalida = false;
  let deducoesColLegadoTTM = 0;
  let receitaLegadoTTM = 0;
  const mesesPE: MesDRE[] = meses.map((m) => {
    if (m.composicao_despesas == null) {
      deducoesColLegadoTTM += m.deducoes_col;
      receitaLegadoTTM += m.receita_bruta;
      return m;
    }
    const r = universoOperacional(m);
    if (r == null) { composicaoInvalida = true; return m; }
    excl.fora_dre += r.excluido.fora_dre;
    excl.deducoes += r.excluido.deducoes;
    excl.imposto_lucro += r.excluido.imposto_lucro;
    excl.outras += r.excluido.outras;
    return { ...m, despesas: r.despesas };
  });

  // ── Agrega TTM por categoria (materialidade é por-código) ───────────────────────────────────
  const porCodigo = new Map<string, number>();
  let receitaTTM = 0;
  let deducoesColTTM = 0;
  let negativosTTM = 0; // Σ das parcelas negativas (sinal — delta-E7)
  for (const m of mesesPE) {
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

  const recente = mesesPE[mesesPE.length - 1];
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
    excluido_fora_dre_ttm: excl.fora_dre,
    excluido_deducoes_ttm: excl.deducoes,
    excluido_imposto_lucro_ttm: excl.imposto_lucro,
    excluido_outras_ttm: excl.outras,
  };

  // 0. Fase 2: composição do snapshot não fecha com o detalhamento ⇒ não dá p/ separar o universo.
  if (composicaoInvalida) return degradar('snapshot_inconsistente', ctx);

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

  // 2b. Fase 2: mês com fora_dre de composição pendente — os juros/encargos dentro da parcela
  // seriam despesa financeira (fixo, se classificada assim) e estão fora: PE seria otimista.
  if (meses.some((m) => m.resultado_provisorio === true)) return degradar('resultado_provisorio', ctx);

  // 3. Sem receita → PE indefinido.
  if (!(receitaTTM > 0)) return degradar('sem_receita', ctx);

  // 4. Double-count de deduções (delta-E5): o design pressupõe imposto no BALDE, não na coluna.
  // Fase 2: só vale para meses LEGADOS. Com composição, o imposto saiu do balde por construção e
  // entra uma única vez via deducoes_col — um mês novo não libera a janela inteira.
  if (receitaLegadoTTM > 0 && deducoesColLegadoTTM / receitaLegadoTTM > cfg.deducoesTolRel)
    return degradar('deducoes_coluna_inesperada', ctx);

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
  const mcMensais = mesesPE
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
    excluido_fora_dre_ttm: excl.fora_dre,
    excluido_deducoes_ttm: excl.deducoes,
    excluido_imposto_lucro_ttm: excl.imposto_lucro,
    excluido_outras_ttm: excl.outras,
    custo_compartilhado_pendente_latente: false,
    can_show_break_even: true,
    detalhes: [],
  };
}
