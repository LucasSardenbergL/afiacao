export interface ClienteAPositivar {
  customer_user_id: string;
  nome: string | null;
  revenue_potential: number | null;
  churn_risk: number | null;
  recover_score: number | null;
  days_since_last_purchase: number | null;
  priority_score: number | null;
}

export interface PositivacaoResumo {
  mes: string; // yyyy-mm-01
  total_eligible: number;
  positivados: number;
  compradores_mtd: number;
  receita_mtd: number;
  contatados_mtd: number;
  recencia_critica: number;
  novos_clientes_positivados: number;
  a_positivar: ClienteAPositivar[];
}
