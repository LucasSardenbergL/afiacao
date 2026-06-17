/**
 * PR-SCORING-V2: tipos do pipeline de modulators de score.
 *
 * Pipeline:
 *   farmer_calls.entities_extracted + farmer_calls.analyses
 *     → modulators (1 modifier por entity/analysis relevante)
 *     → aggregate (soma com decay temporal)
 *     → ScoreAdjustment (deltas finais aplicados em farmer_client_scores)
 */

export type EntityType =
  | 'competitor'
  | 'price'
  | 'volume'
  | 'product'
  | 'timeline'
  | 'decision_maker';

export interface ExtractedEntity {
  type: EntityType;
  value: string;
  context: string;
  confidence: number; // 0-1
}

/**
 * Snapshot de análise SPIN persistido em farmer_calls.analyses (do PR3/PR3.5).
 * Não importa toda a estrutura — só os campos que viram modifier.
 */
export interface AnalysisSnapshot {
  playbook?: 'discovery' | 'teach' | 'close';
  opportunities?: Array<{ type: string; value?: number; description?: string }>;
  risks?: Array<{ severity: 'baixa' | 'media' | 'alta'; description?: string }>;
  entitiesExtracted?: ExtractedEntity[];
  // outros campos ignorados intencionalmente
}

/**
 * Dimensões de score que um modifier pode tocar.
 * Mapeia 1:1 nas colunas de farmer_client_scores.
 */
export type ScoreDimension = 'churn' | 'expansion' | 'health' | 'eff';

/**
 * Tipos de sinal reconhecidos pelo modulators.ts.
 * Adicionar novo: 1) cria branch no modulators, 2) cobre teste.
 */
export type SignalKind =
  | 'competitor_mentioned'
  | 'price_objection_high'
  | 'desired_outcome'
  | 'opportunity_upsell'
  | 'risk_high'
  | 'close_attempted_no_close';

/**
 * Modifier individual: 1 entity ou 1 analysis pode gerar 1 modifier (ou nenhum).
 * `decayedWeight` é o `weight` após aplicação do decay temporal.
 */
export interface SignalModifier {
  dimension: ScoreDimension;
  kind: SignalKind;
  delta: number; // pontos a somar (positivo) ou subtrair (negativo) na dimensão
  weight: number; // peso base (1.0 = sinal forte; 0.5 = sinal fraco)
  decayedWeight: number;
  reason: string; // texto humano pra UI ("Concorrente Farben mencionado")
  sourceCallId: string;
  capturedAt: string; // ISO timestamp do farmer_calls.started_at
  daysSince: number;
  // FA4 (Fatia 2 — shadow-mode): classe do sinal carimbada na extração (sinais_ligacao).
  // O visit-score só aplica modifiers de classe ATIVADA (sinal_classe_config.ativado=true), via
  // aplicaveis() em visit-scoring/missions.ts; modifier sem `class` (legado) ou de classe OFF é
  // excluído. Espelha o tipo inline do edge supabase/functions/visit-score-recalc-client/index.ts.
  class?: 'preco' | 'marca' | 'demanda';
}

/**
 * Ajuste final pra UPSERT em farmer_client_scores.
 * Cada dimensão acumula a soma dos deltas dos modifiers que tocam ela.
 * `breakdown` vai pra coluna signal_modifiers (jsonb) pra UI mostrar tooltip.
 */
export interface ScoreAdjustment {
  churn_delta: number;
  expansion_delta: number;
  health_delta: number;
  eff_delta: number;
  breakdown: {
    churn: SignalModifier[];
    expansion: SignalModifier[];
    health: SignalModifier[];
    eff: SignalModifier[];
  };
  computed_at: string; // ISO
  source_call_count: number;
}
