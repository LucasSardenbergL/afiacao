// Borda das tabelas master-only do financeiro. O que o types.ts não sabe dizer — vocabulário de CHECK, que
// o gerador vira `string`, e jsonb — é conferido AQUI, lançando fora da forma, em vez de afirmado por cast
// (`supabase as unknown as {from: …}` / `data as unknown as Tipo[]`). Os spreads preservam as demais
// colunas da linha, como o cast antigo deixava passar (o payload dos upserts que reusam a linha não muda).
// Vocabulários = CHECK de prod (pg_constraint via psql-ro, 2026-10-20). Puro — testável sem cliente.
import type { Json, Tables } from '@/integrations/supabase/types';
import type { FundingInputs } from '@/services/financeiroService';
import type { Divida } from './endividamento-types';
import type { Antecipacao } from './antecipacao-types';
import type { TipoCusto } from './ponto-equilibrio-helpers';
import { booleano, campo, numero, objeto, opcional, uniao, type Leitor } from './borda-json';

const EMPRESAS = ['oben', 'colacor', 'colacor_sc'] as const;
const empresa = uniao(EMPRESAS);

// ─── fin_dividas ────────────────────────────────────────────────────────────────────────────────

export function paraDivida(l: Tables<'fin_dividas'>): Divida {
  const onde = `fin_dividas ${l.id}`;
  return {
    ...l,
    company: empresa(l.company, `${onde}.company`),
    tipo: uniao(['capital_giro', 'financiamento', 'antecipacao_recorrente', 'outro'])(l.tipo, `${onde}.tipo`),
    cp_inclusion_status: uniao(['sim', 'nao', 'parcial', 'nao_sei'])(l.cp_inclusion_status, `${onde}.cp_inclusion_status`),
    coobrigada_por: l.coobrigada_por === null ? null : empresa(l.coobrigada_por, `${onde}.coobrigada_por`),
  };
}

// ─── fin_antecipacoes ───────────────────────────────────────────────────────────────────────────

export function paraAntecipacao(l: Tables<'fin_antecipacoes'>): Antecipacao {
  const onde = `fin_antecipacoes ${l.id}`;
  return {
    ...l,
    company: empresa(l.company, `${onde}.company`),
    tipo: uniao(['duplicata', 'linha'])(l.tipo, `${onde}.tipo`),
  };
}

// ─── fin_dre_custo_tipo ─────────────────────────────────────────────────────────────────────────

export type CustoTipoRow = {
  /** Empresa OU `_default` (linha-base que a empresa sobrepõe) — por isso não passa pela guarda de empresa. */
  company: string;
  categoria_codigo: string;
  tipo: TipoCusto;
  observacao: string | null;
};

export function paraCustoTipo(l: Pick<Tables<'fin_dre_custo_tipo'>, keyof CustoTipoRow>): CustoTipoRow {
  return {
    ...l,
    tipo: uniao(['fixo', 'variavel', 'misto', 'nao_operacional'])(l.tipo, `fin_dre_custo_tipo ${l.company}/${l.categoria_codigo}.tipo`),
  };
}

// ─── fin_eventos_eventuais / fin_eventos_recorrentes ────────────────────────────────────────────

const tipoEvento = uniao(['entrada', 'saida']);

export function paraEventoEventual<L extends Tables<'fin_eventos_eventuais'>>(l: L) {
  const onde = `fin_eventos_eventuais ${l.id}`;
  return {
    ...l,
    tipo: tipoEvento(l.tipo, `${onde}.tipo`),
    status: uniao(['previsto', 'confirmado', 'cancelado', 'realizado'])(l.status, `${onde}.status`),
  };
}

export function paraEventoRecorrente<L extends Tables<'fin_eventos_recorrentes'>>(l: L) {
  return { ...l, tipo: tipoEvento(l.tipo, `fin_eventos_recorrentes ${l.id}.tipo`) };
}

// ─── fin_alertas ────────────────────────────────────────────────────────────────────────────────

export function paraAlerta<L extends Tables<'fin_alertas'>>(l: L) {
  const onde = `fin_alertas ${l.id}`;
  return {
    ...l,
    severidade: uniao(['info', 'aviso', 'critico'])(l.severidade, `${onde}.severidade`),
    contexto: l.contexto === null ? null : objeto(l.contexto, `${onde}.contexto`),
  };
}

// ─── fin_config_cashflow (jsonb por forma) ──────────────────────────────────────────────────────

export type OverrideCenario = { recebimento_no_prazo_pct_delta: number; inadimplencia_pct_delta: number };
export type ThresholdsCashflow = {
  caixa_negativo_semanas: number;
  ncg_deficit_alerta: number;
  dias_cobertura_min: number;
  inadimplencia_max_pct: number;
  concentracao_top1_max_pct: number;
  pmr_crescimento_max_pct_90d: number;
};
export type CashflowConfig = {
  company: string;
  overrides_cenario: { otimista: OverrideCenario; pessimista: OverrideCenario };
  thresholds: ThresholdsCashflow;
  adiantamento_categorias_codigos: string[];
};

const lerOverride: Leitor<OverrideCenario> = (v, onde) => {
  const o = objeto(v, onde);
  return {
    recebimento_no_prazo_pct_delta: campo(o, 'recebimento_no_prazo_pct_delta', numero, onde),
    inadimplencia_pct_delta: campo(o, 'inadimplencia_pct_delta', numero, onde),
  };
};

const lerThresholds: Leitor<ThresholdsCashflow> = (v, onde) => {
  const o = objeto(v, onde);
  return {
    caixa_negativo_semanas: campo(o, 'caixa_negativo_semanas', numero, onde),
    ncg_deficit_alerta: campo(o, 'ncg_deficit_alerta', numero, onde),
    dias_cobertura_min: campo(o, 'dias_cobertura_min', numero, onde),
    inadimplencia_max_pct: campo(o, 'inadimplencia_max_pct', numero, onde),
    concentracao_top1_max_pct: campo(o, 'concentracao_top1_max_pct', numero, onde),
    pmr_crescimento_max_pct_90d: campo(o, 'pmr_crescimento_max_pct_90d', numero, onde),
  };
};

/** Toda chave numérica é obrigatória: config pela metade LANÇA (o dialog não edita um limite inventado). */
export function paraCashflowConfig(l: Tables<'fin_config_cashflow'>): CashflowConfig {
  const onde = `fin_config_cashflow ${l.company}`;
  const cen = objeto(l.overrides_cenario, `${onde}.overrides_cenario`);
  return {
    company: l.company,
    overrides_cenario: {
      otimista: campo(cen, 'otimista', lerOverride, `${onde}.overrides_cenario`),
      pessimista: campo(cen, 'pessimista', lerOverride, `${onde}.overrides_cenario`),
    },
    thresholds: lerThresholds(l.thresholds, `${onde}.thresholds`),
    adiantamento_categorias_codigos: l.adiantamento_categorias_codigos,
  };
}

// ─── fin_funding_inputs (jsonb por forma, PARCIAL) ──────────────────────────────────────────────

type Fontes = FundingInputs['fontes'];
/**
 * O que está GRAVADO, não o que o formulário completa: em prod (2026-10-20) as 3 empresas têm `{}`. O
 * cast antigo entregava esse `{}` como FundingInputs completo; o tipo honesto é parcial em profundidade,
 * e o FundingInputsDialog já completa com seus DEFAULTS. Chave ausente continua ausente (sem `undefined`
 * explícito, que apagaria o default no spread do merge).
 */
export type FundingInputsSalvos = {
  fontes?: { [K in keyof Fontes]?: Partial<Fontes[K]> };
  reserva_dias_min?: number;
  gap_estrutural_semanas_min?: number;
};

const lerAntecipacaoSalva: Leitor<Partial<Fontes['antecipacao']>> = (v, onde) => {
  const o = objeto(v, onde);
  const out: Partial<Fontes['antecipacao']> = {};
  opcional(out, o, 'taxa_desconto_mensal_perc', numero, onde);
  opcional(out, o, 'tarifa_fixa', numero, onde);
  opcional(out, o, 'tipo', uniao(['desconto', 'factoring']), onde);
  opcional(out, o, 'coobrigacao', booleano, onde);
  return opcional(out, o, 'ativo', booleano, onde);
};

const lerCetSalvo: Leitor<Partial<{ cet_anual_perc: number; ativo: boolean }>> = (v, onde) => {
  const o = objeto(v, onde);
  const out: Partial<{ cet_anual_perc: number; ativo: boolean }> = {};
  opcional(out, o, 'cet_anual_perc', numero, onde);
  return opcional(out, o, 'ativo', booleano, onde);
};

export function lerFundingInputsSalvos(v: Json, onde: string): FundingInputsSalvos {
  const o = objeto(v, onde);
  const out: FundingInputsSalvos = {};
  if (o.fontes !== undefined) {
    const f = objeto(o.fontes, `${onde}.fontes`);
    const fontes: NonNullable<FundingInputsSalvos['fontes']> = {};
    opcional(fontes, f, 'antecipacao', lerAntecipacaoSalva, `${onde}.fontes`);
    opcional(fontes, f, 'capital_giro', lerCetSalvo, `${onde}.fontes`);
    opcional(fontes, f, 'cheque_especial', lerCetSalvo, `${onde}.fontes`);
    out.fontes = fontes;
  }
  opcional(out, o, 'reserva_dias_min', numero, onde);
  return opcional(out, o, 'gap_estrutural_semanas_min', numero, onde);
}
