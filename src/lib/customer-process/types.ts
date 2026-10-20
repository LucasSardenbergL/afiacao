/** Vocabulário de `ProcessEtapa.tipo` — o mesmo que a edge `structure-customer-process` devolve. */
export const TIPOS_ETAPA = ['preparacao', 'aplicacao', 'secagem', 'lixamento', 'mistura', 'inspecao', 'embalagem', 'outro'] as const;
export type TipoEtapa = (typeof TIPOS_ETAPA)[number];

/** Vocabulário de `porte` (coluna texto em `customer_processes`; só a edge escreve). */
export const PORTES_PROCESSO = ['pequeno', 'medio', 'grande'] as const;
export type PorteProcesso = (typeof PORTES_PROCESSO)[number];

// `type` (não `interface`) de propósito: só o type literal é atribuível a `Json` do types.ts
// gerado — é o que deixa `etapas: ProcessEtapa[]` entrar no insert SEM `as unknown as Json`.
export type ProcessEtapa = {
  ordem: number;
  nome: string;                          // "Aplicação primer", "Secagem final", "Lixamento intermediário"
  tipo: TipoEtapa;
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
};

export interface CustomerProcess {
  id: string;
  customer_user_id: string;
  descricao_livre: string;
  etapas: ProcessEtapa[] | null;
  segmento: string | null;
  porte: PorteProcesso | null;
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
  porte: PorteProcesso;
  tags: string[];
  ia_confidence: number;
  ia_gaps: string[];
}
