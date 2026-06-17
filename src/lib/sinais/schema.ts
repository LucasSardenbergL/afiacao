/** Tipos compartilhados da captura inteligente (Fatia 2).
 *  Espelhados inline na edge scoring-recalc-client (Deno) — este módulo é a fonte testada. */

export type ClasseSinal = 'preco' | 'marca' | 'demanda';

/** Threshold de confiança p/ um sinal pontuar no scoring. Calibrável no piloto (Fase B). */
export const PROB_MIN = 0.6;

export interface Preco {
  tipo: 'cliente_paga' | 'concorrente_cobra';
  produto: string | null;
  valor: number | null;
  moeda: string | null;
  unidade_base: string | null;
  concorrente: string | null;
  speaker_is_customer: boolean;
  confianca: number;
  evidencia: string;
}

export interface MarcaEmUso {
  marca: string;
  produto: string | null;
  e_concorrente: boolean | null;
  speaker_is_customer: boolean;
  confianca: number;
  evidencia: string;
}

export interface ProdutoGap {
  descricao: string;
  familia: string | null;
  material: string | null;
  dimensao: string | null;
  recorrente: boolean | null;
  confianca: number;
  evidencia: string;
}

export interface DemandaNova {
  descricao: string;
  contexto: string | null;
  urgencia: string | null;
  recorrente: boolean | null;
  confianca: number;
  evidencia: string;
}

export interface SinaisLigacao {
  precos: Preco[];
  marcas_em_uso: MarcaEmUso[];
  produtos_gap: ProdutoGap[];
  demandas_novas: DemandaNova[];
  houve_sinal: boolean;
}

/** Modifier bruto produzido pelo conversor (antes do decay/agregação do scoring). */
export interface ModifierBruto {
  dimension: 'churn' | 'expansion';
  kind: string;
  delta: number;
  weight: number;
  reason: string;
  classe: ClasseSinal;
}
