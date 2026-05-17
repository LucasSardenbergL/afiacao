/** Versão lite do TranscriptTurn pro payload da edge — sem refs internas */
export interface TranscriptTurnLite {
  speaker: 'vendedor' | 'cliente';
  text: string;
  isFinal: boolean;
  startedAt: number;
}

export type SpinStage = 'opening' | 'situation' | 'problem' | 'implication' | 'need_payoff' | 'closing';

export type NextActionType = 'question' | 'response' | 'transition' | 'close' | 'listen';

export type RiskType =
  | 'price_objection'
  | 'competitor_mentioned'
  | 'lack_of_urgency'
  | 'wrong_decision_maker'
  | 'technical_doubt'
  | 'other';

export type RiskSeverity = 'low' | 'medium' | 'high';

export interface SpinAnalysis {
  /** Estágio atual da conversa segundo SPIN */
  spinStage: SpinStage;
  /** Confiança da análise (0-1) */
  confidence: number;
  /** O que o cliente revelou até agora */
  whatClientRevealed: {
    situationFacts: string[];
    problemsAdmitted: string[];
    implications: string[];
    desiredOutcomes: string[];
  };
  /** Próxima ação sugerida pro vendedor (a estrela do show) */
  nextBestAction: {
    type: NextActionType;
    /** Que tipo de pergunta SPIN seria essa (null se type=close/listen) */
    spinType: SpinStage | null;
    /** Texto EXATO pro vendedor falar (PT-BR, tom natural) */
    exactPhrasing: string;
    /** Por que essa ação agora — uma frase curta */
    whyNow: string;
  };
  /** Riscos detectados na conversa */
  risks: Array<{
    type: RiskType;
    severity: RiskSeverity;
    note: string;
  }>;
  /** Hints de cross-sell pra PR4 consumir; pode ser array vazio */
  crossSellTriggers: Array<{
    productHint: string;
    triggerPhrase: string;
  }>;
}

export type SpinAnalysisStatus = 'idle' | 'analyzing' | 'ready' | 'error';
