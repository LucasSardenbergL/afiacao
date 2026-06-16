// Tipos do check-in qualitativo DES.
// Extraídos verbatim de src/components/des/CheckinQualitativoTab.tsx (god-component split).

export interface Props {
  empresa: string;
  ano: number;
  trimestre: number;
}

export interface Criterio {
  id: number;
  codigo: string;
  nome: string;
  descricao: string | null;
  ordem: number;
  tipo: "qualitativo" | "bonus" | string;
}

export interface CriterioPercentual {
  criterio_id: number;
  faixa_id: number;
  percentual: number;
}

export interface DescontoCheckin {
  checkin_id: number;
  data_avaliacao: string;
  tipo: string;
  faixa_numero: number | null;
  estrelas: number | null;
  desconto_padrao: number | null;
  qualitativos_atingidos_perc: number | null;
  bonus_atingido_perc: number | null;
  desconto_total_projetado: number | null;
  desconto_total_maximo: number | null;
  avaliado_por?: string | null;
}

export interface CheckinAtualRow {
  checkin_id: number;
  data_avaliacao: string;
  tipo: string;
  avaliado_com: string | null;
  avaliado_por: string | null;
  codigo: string;
  nome: string;
  criterio_tipo: string;
  atingido: boolean;
  observacao_criterio: string | null;
}

export interface FaixaInfo {
  faixa_id: number | null;
  [key: string]: unknown;
}

export interface PosicaoTrimestreRow {
  faixa_conservadora: FaixaInfo | null;
  faixa_otimista: FaixaInfo | null;
}

export interface DescontoCheckinRow {
  checkin_id: number;
  data_avaliacao: string;
  tipo: string;
  faixa_numero: number | null;
  estrelas: number | null;
  desconto_padrao: number | null;
  qualitativos_atingidos_perc: number | null;
  bonus_atingido_perc: number | null;
  desconto_total_projetado: number | null;
  desconto_total_maximo: number | null;
}

export interface CheckinQualitativoRow {
  id: number;
  avaliado_por: string | null;
}

export interface Resposta {
  atingido: boolean;
  observacao: string;
}
