export interface GapCliente {
  customer_user_id: string;
  nome: string | null;
  familia_faltante: string;
  confidence: number;
  lift: number;
  evidence_count: number;
  feedback_status?: 'ofertado' | null;
}

export interface MixGapResumo {
  total_com_gap: number;
  lista: GapCliente[];
}
