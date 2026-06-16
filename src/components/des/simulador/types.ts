// Tipos do simulador DES (puxar volume no trimestre).
// Extraídos verbatim de src/components/des/SimuladorTab.tsx (god-component split).

export interface Props {
  empresa: string;
  ano: number;
  trimestre: number;
}

export interface PrazoOption {
  id: number;
  codigo: string;
  nome: string;
  desconto_ou_encargo_perc: number;
  padrao: boolean;
  ativo: boolean;
}

export interface SimResult {
  posicao?: {
    base?: number;
    com_extra?: number;
    nominal_adicional_na_nf?: number;
    fator_inflacao?: number;
    mudou_faixa?: boolean;
    faixa_atual?: { faixa_numero?: number; estrelas?: number };
    faixa_nova?: { faixa_numero?: number; estrelas?: number };
  };
  perdas_pedido_atual?: {
    perda_antecipado_rs?: number;
    encargo_prazo_rs?: number;
    frete_rs?: number;
    custo_capital_rs?: number;
    total_rs?: number;
  };
  projecao?: {
    proximo_trimestre_projetado?: number;
    ganho_futuro_rs?: number;
  };
  descontos?: {
    base_perc?: number;
    com_extra_perc?: number;
    delta_perc?: number;
  };
  saldo_liquido_rs?: number;
  recomendacao?: "compensa" | "compensa_marginalmente" | "indiferente" | "nao_compensa" | string;
  parametros?: Record<string, unknown>;
}
