export interface ProcessEtapa {
  ordem: number;
  nome: string;                          // "Aplicação primer", "Secagem final", "Lixamento intermediário"
  tipo: 'preparacao' | 'aplicacao' | 'secagem' | 'lixamento' | 'mistura' | 'inspecao' | 'embalagem' | 'outro';
  produtos: string[];                    // ["nitro Renner", "lixa 220", "diluente comum"]
  parametros: {
    tempo_minutos?: number;
    temperatura_c?: number;
    umidade_pct?: number;
    espessura_um?: number;
    pressao_bar?: number;
    distancia_cm?: number;
  };
  equipamentos: string[];                // ["pistola HVLP", "cabine de pintura", "estufa"]
  observacoes: string;
}

export interface CustomerProcess {
  id: string;
  customer_user_id: string;
  descricao_livre: string;
  etapas: ProcessEtapa[] | null;
  segmento: string | null;
  porte: 'pequeno' | 'medio' | 'grande' | null;
  tags: string[];
  ia_confidence: number | null;
  ia_gaps: string[];
  ia_structured_at: string | null;
  version: number;
  parent_id: string | null;
  is_current: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Resposta da edge fn structure-customer-process */
export interface StructuredProcessResponse {
  etapas: ProcessEtapa[];
  segmento: string;
  porte: 'pequeno' | 'medio' | 'grande';
  tags: string[];
  ia_confidence: number;
  ia_gaps: string[];
}
