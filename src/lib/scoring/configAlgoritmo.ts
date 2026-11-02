/**
 * Config do algoritmo do Farmer (pesos do health/priority, cotas da agenda, SLA) e o DEFAULT que o
 * motor usa para chave AUSENTE numa leitura bem-sucedida de `farmer_algorithm_config`.
 *
 * Mora aqui, e não no `useFarmerScoring`, para quebrar o ciclo: o motor passou a ler a config por
 * `useFarmerAlgorithmConfig`, que precisava do DEFAULT do próprio motor (plano v4, lote 16).
 * O DEFAULT não é "config desconhecida": leitura que FALHA não vira default (ver o hook).
 */
export interface AlgorithmConfig {
  k1: number; k2: number; cat_target: number;
  health_w_rf: number; health_w_m: number; health_w_g: number;
  health_w_x: number; health_w_s: number;
  priority_w_churn: number; priority_w_recover: number;
  priority_w_expansion: number; priority_w_eff: number;
  agenda_pct_risco: number; agenda_pct_expansao: number;
  agenda_pct_followup: number; sla_contact_days: number;
}

export const DEFAULT_CONFIG: AlgorithmConfig = {
  k1: 1.0, k2: 1.0, cat_target: 5,
  health_w_rf: 0.35, health_w_m: 0.20, health_w_g: 0.15,
  health_w_x: 0.15, health_w_s: 0.15,
  priority_w_churn: 0.40, priority_w_recover: 0.30,
  priority_w_expansion: 0.20, priority_w_eff: 0.10,
  agenda_pct_risco: 0.50, agenda_pct_expansao: 0.30,
  agenda_pct_followup: 0.20, sla_contact_days: 14,
};
