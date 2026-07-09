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

/** Qual playbook o copilot está executando agora */
export type CopilotPlaybook = 'discovery' | 'teach' | 'close';

/** Alavanca tática de aumento de ticket sugerida */
export type TicketLeverage = 'anchor_premium' | 'bundle' | 'reframe_cost' | 'none';

/** Tática específica quando playbook=close (JOLT) */
export type DecisionPushTactic = 'recommendation' | 'risk_reversal' | 'simplification';

/** Entidade econômica detectada na transcrição (concorrente, preço, etc) */
export interface ExtractedEntity {
  type: 'competitor' | 'price' | 'volume' | 'product' | 'timeline' | 'decision_maker';
  value: string;
  context: string;  // trecho original onde apareceu
  confidence: number;  // 0-1
}

export interface SpinAnalysis {
  /** Estágio atual da conversa segundo SPIN */
  spinStage: SpinStage;
  /** Confiança da análise (0-1) */
  confidence: number;
  /** NOVO: qual playbook o copilot escolheu acionar agora */
  playbook: CopilotPlaybook;
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
    /** NOVO: insight comercial pronto pra falar (só preenche quando playbook=teach) */
    commercialInsight?: {
      dataPoint: string;
      reframe: string;
    };
    /** NOVO: tática JOLT específica (só preenche quando playbook=close) */
    decisionPushTactic?: DecisionPushTactic;
  };
  /** NOVO: alavanca de ticket sugerida (qualquer playbook, 'none' se sem oportunidade) */
  ticketLeverage: {
    tactic: TicketLeverage;
    suggestion: string;
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
  /** NOVO: entidades econômicas extraídas (PR4+ vai persistir no perfil 360) */
  entitiesExtracted: ExtractedEntity[];
}

export type SpinAnalysisStatus = 'idle' | 'analyzing' | 'ready' | 'error';
