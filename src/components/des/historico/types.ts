// Tipos do HistoricoTab (DES — dashboard executivo).
// Extraídos verbatim de src/components/des/HistoricoTab.tsx (god-component split).

export interface Props {
  empresa: string;
  ano: number;
  trimestre: number;
}

export interface MetaRow {
  ano: number;
  trimestre: number;
  meta_faturamento: number;
  faixa_des_objetivo: number | null;
}

export interface SnapshotRow {
  ano: number;
  trimestre: number;
  data_referencia: string;
  fat_bruto_valor: number | null;
  pedidos_abertos_valor: number | null;
  objetivo_valor: number | null;
}

export interface CheckinDescontoRow {
  checkin_id: number;
  ano: number;
  trimestre: number;
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

export interface PosicaoLiveRow {
  ano: number;
  trimestre: number;
  posicao_ao_vivo_conservadora: number | null;
  faixa_conservadora: { faixa_numero?: number; estrelas?: number } | null;
  meta_pessoal: number | null;
  inicio_trimestre: string | null;
  fim_trimestre: string | null;
}

export interface QuarterCard {
  ano: number;
  trimestre: number;
  isAtual: boolean;
  meta: number;
  faturado: number;
  faixaEstrelas: number;
  inicio: string | null;
  fim: string | null;
  ultimoCheckin: CheckinDescontoRow | null;
  snapshots: SnapshotRow[];
}

export interface ChartDatum {
  label: string;
  faturado: number;
  meta: number;
  isAtual: boolean;
}
