// F1 Módulo de Endividamento — tipos puros (helper testado em vitest).
// Spec: docs/superpowers/specs/2026-07-04-endividamento-dscr-design.md
// Datas em ISO YYYY-MM-DD (datas puras, comparáveis lexicograficamente — sem TZ).

export type Company = 'oben' | 'colacor' | 'colacor_sc';
export type TipoDivida = 'capital_giro' | 'financiamento' | 'antecipacao_recorrente' | 'outro';
export type CpInclusionStatus = 'sim' | 'nao' | 'parcial' | 'nao_sei';

export interface Divida {
  id: string;
  company: Company;
  credor: string;
  tipo: TipoDivida;
  principal_contratado: number;
  saldo_devedor_informado: number | null;
  saldo_devedor_data_base: string | null; // ISO YYYY-MM-DD
  cp_inclusion_status: CpInclusionStatus;
  cp_inclusion_ate: string | null;
  data_contratacao: string;
  cet_aa: number | null;
  indexador: string | null;
  coobrigada_por: Company | null;
  garantias: string | null;
  observacao: string | null;
  ativo: boolean;
}

export interface Parcela {
  id: string;
  divida_id: string;
  numero_parcela: number;
  data_vencimento: string; // ISO YYYY-MM-DD
  valor_amortizacao: number;
  valor_juros: number;
  valor_total: number;
  estimado: boolean;
  pago: boolean;
}

export interface ServicoDivida {
  vencido: number; // não-pago, vencimento < hoje (pressão represada)
  aVencer: number; // não-pago, hoje <= vencimento <= fim
  total: number; // vencido + aVencer
}

export type DscrMotivo = 'ok' | 'inconclusivo' | 'sem_divida' | 'sem_geracao';
export interface DscrResult {
  valor: number | null;
  motivo: DscrMotivo;
}

export interface IndicadorEbitda {
  valor: number | null;
  motivo: 'ok' | 'falta_ebitda' | 'sem_divida';
}
