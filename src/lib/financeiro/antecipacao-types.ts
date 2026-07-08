// F4 — Antecipação de recebíveis. Tipos PUROS (helper testado em vitest).
// Spec: docs/superpowers/specs/2026-07-07-antecipacao-recebiveis-design.md
// Money-path: ausente ≠ zero; sem operação = sem custo (degrada por motivo, nunca fabrica).
// Datas ISO YYYY-MM-DD puras (sem TZ). Os 5 P1 do Codex (spec §11) são lei.

export type Company = 'oben' | 'colacor' | 'colacor_sc';
export type TipoAntecipacao = 'duplicata' | 'linha';
/** Unidade EXPLÍCITA do hurdle/oferta (P1-3: sem unidade a comparação é lixo). */
export type HurdleUnidade = 'efetiva_aa' | 'nominal_aa' | 'efetiva_am';

export interface Antecipacao {
  id: string;
  company: Company;
  banco: string | null;
  tipo: TipoAntecipacao;
  valor_bruto: number; // FACE ANTECIPADA (não a face total do título)
  custos_avulsos: number; // >= 0 — IOF/tarifa FORA do líquido (P1-4)
  valor_liquido: number; // > 0 — o que caiu na conta
  data_operacao: string; // ISO
  data_vencimento: string; // ISO
  operacao_origem_id: string | null;
  referencia: string | null;
  observacao: string | null;
  deleted_at: string | null;
}

export type MotivoOperacao = 'ok' | 'dados_invalidos';
export interface CustoOperacao {
  motivo: MotivoOperacao;
  custo: number | null; // bruto + avulsos − liquido
  dias: number | null;
  taxa_periodo: number | null; // (bruto+avulsos)/liquido − 1
  taxa_efetiva_aa: number | null;
}

export type MotivoMedidor = 'ok' | 'sem_operacoes' | 'dados_parciais';
export interface MesAntecipacao {
  ano: number;
  mes: number;
  custo: number;
  volume: number;
}
export interface MedidorResult {
  motivo: MotivoMedidor;
  custo_total: number | null;
  volume_antecipado: number | null;
  taxa_realizada_aa: number | null; // money-weighted (P1-2)
  num_operacoes: number; // válidas incluídas
  num_excluidas: number; // inválidas excluídas (dados_parciais)
  tendencia: MesAntecipacao[]; // por data_operacao (base declarada, P1)
}

export interface Hurdle {
  valor: number;
  unidade: HurdleUnidade;
}
export type MotivoFunding =
  | 'ok'
  | 'dados_invalidos'
  | 'inputs_conflitantes'
  | 'hurdle_unidade_invalida'
  | 'hurdle_indisponivel'
  | 'fluxo_nao_suportado';
export interface FundingInput {
  valor_titulo: number; // face antecipada da oferta
  dias: number;
  custos_avulsos?: number; // default 0
  liquido_ofertado?: number | null; // oferta como líquido
  taxa_ofertada?: Hurdle | null; // OU oferta como taxa (com unidade)
  hurdle?: Hurdle | null; // editável PRIMÁRIO; ausente → hurdle_indisponivel
  lote?: boolean; // true = lote multi-venc num prazo só → fluxo_nao_suportado
}
export interface FundingResult {
  motivo: MotivoFunding;
  custo: number | null;
  taxa_periodo: number | null;
  taxa_efetiva_aa: number | null;
  hurdle_taxa_periodo: number | null; // hurdle convertido p/ os mesmos `dias`
  veredito: 'mais_caro' | 'dentro' | null; // SÓ de funding (P1-3), nunca "vale a pena"
}

export type MotivoHurdleSugerido = 'ok' | 'sem_dados';
export interface HurdleSugerido {
  valor: number | null;
  unidade: HurdleUnidade | null;
  motivo: MotivoHurdleSugerido;
}
