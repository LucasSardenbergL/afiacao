// Tipos da aba de Configuração de meta trimestral do DES.

export interface Props {
  empresa: string;
  ano: number;
  trimestre: number;
}

export interface MetaRow {
  id: number;
  empresa: string;
  ano: number;
  trimestre: number;
  meta_faturamento: number;
  faixa_des_objetivo: number | null;
  observacoes: string | null;
}
