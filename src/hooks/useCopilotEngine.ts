import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { EdgeFunctionError, invokeFunction } from '@/lib/invoke-function';
import { useAuth } from '@/contexts/AuthContext';

// ─── Types ───────────────────────────────────────────────────────────
export type CopilotIntent = 'interesse' | 'objecao_preco' | 'objecao_tecnica' | 'falta_urgencia' | 'comparacao_concorrente' | 'indiferenca';
export type CopilotPhase = 'abertura' | 'diagnostico' | 'exploracao' | 'proposta' | 'fechamento';
export type CopilotDirection = 'positivo' | 'neutro' | 'risco';
export type SuggestionType = 'pergunta_diagnostica' | 'resposta_tecnica' | 'argumento_economico' | 'alternativa_abordagem';

export interface CopilotAnalysis {
  intent: CopilotIntent;
  phase: CopilotPhase;
  direction: CopilotDirection;
  directionReasons: string[];
  suggestion: string;
  suggestionType: SuggestionType;
  confidence: number;
}

export interface TranscriptEntry {
  id: string;
  text: string;
  speaker: 'farmer' | 'customer' | 'unknown';
  timestamp: Date;
  isPartial?: boolean;
}

export type CopilotContext = Record<string, unknown>;

export interface CopilotSession {
  id: string;
  customerId?: string;
  customerName?: string;
  startedAt: Date;
  bundleContext?: CopilotContext;
  customerContext?: CopilotContext;
}

interface CopilotAnalyzeResponse {
  intent?: CopilotIntent;
  phase?: CopilotPhase;
  direction?: CopilotDirection;
  direction_reasons?: string[];
  suggestion?: string;
  suggestion_type?: SuggestionType;
  confidence?: number;
}

interface CopilotState {
  isActive: boolean;
  session: CopilotSession | null;
  transcript: TranscriptEntry[];
  currentAnalysis: CopilotAnalysis | null;
  analysisHistory: CopilotAnalysis[];
  isAnalyzing: boolean;
  /** A leitura exibida ficou para trás (a última tentativa falhou). */
  analiseObsoleta: boolean;
  /** Cota de IA estourada: a mensagem da edge, exibida como tal. Enquanto
   *  preenchida, os ticks NÃO disparam — retentar de 8 em 8s contra um limite
   *  que não vai ceder só gasta requisição e mantém a vendedora no escuro. */
  avisoCota: string | null;
  suggestionsShown: number;
  suggestionsUsed: number;
}

const ANALYSIS_INTERVAL_MS = 8000; // Analyze every 8 seconds of new speech
const MIN_TRANSCRIPT_LENGTH = 20;
/** Sem `Retry-After` utilizável, espera um valor conservador antes de reabrir. */
const ESPERA_COTA_PADRAO_MS = 5 * 60 * 1000;

export const useCopilotEngine = () => {
  const { user } = useAuth();
  const [state, setState] = useState<CopilotState>({
    isActive: false,
    session: null,
    transcript: [],
    currentAnalysis: null,
    analysisHistory: [],
    isAnalyzing: false,
    analiseObsoleta: false,
    avisoCota: null,
    suggestionsShown: 0,
    suggestionsUsed: 0,
  });

  const analysisTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastAnalyzedRef = useRef<string>('');
  /** Epoch em ms até quando a cota está estourada. 0 = liberado. */
  const cotaBloqueadaAteRef = useRef<number>(0);
  // Descarta resposta fora de ordem: com tick de 8s, uma análise lenta pode
  // terminar DEPOIS de uma mais nova e sobrescrever a tela com leitura velha —
  // "risco" atual viraria "neutro" obsoleto.
  const analiseSeqRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);

  // Start a copilot session
  const startSession = useCallback(async (params: {
    customerId?: string;
    customerName?: string;
    bundleContext?: CopilotContext;
    customerContext?: CopilotContext;
  }) => {
    if (!user?.id) return;

    const { data } = await supabase
      .from('farmer_copilot_sessions')
      .insert({
        farmer_id: user.id,
        customer_user_id: params.customerId || null,
      })
      .select('id')
      .single();

    const sessionId = data?.id || crypto.randomUUID();
    sessionIdRef.current = sessionId;

    const session: CopilotSession = {
      id: sessionId,
      customerId: params.customerId,
      customerName: params.customerName,
      startedAt: new Date(),
      bundleContext: params.bundleContext,
      customerContext: params.customerContext,
    };

    // A cota é por janela de TEMPO, não por sessão: abrir uma ligação nova não
    // devolve chamadas. Por isso o aviso só é limpo se a janela já virou —
    // apagá-lo aqui deixaria a vendedora numa ligação com o copiloto mudo e sem
    // explicação, que é o estado que este PR existe para eliminar.
    const cotaAindaBloqueada = cotaBloqueadaAteRef.current > Date.now();
    setState(prev => ({
      ...prev,
      isActive: true,
      session,
      transcript: [],
      currentAnalysis: null,
      analysisHistory: [],
      analiseObsoleta: false,
      avisoCota: cotaAindaBloqueada ? prev.avisoCota : null,
      suggestionsShown: 0,
      suggestionsUsed: 0,
    }));

    // Start periodic analysis
    analysisTimerRef.current = setInterval(() => {
      triggerAnalysis();
    }, ANALYSIS_INTERVAL_MS);
  }, [user]);

  // End session
  const endSession = useCallback(async () => {
    if (analysisTimerRef.current) {
      clearInterval(analysisTimerRef.current);
      analysisTimerRef.current = null;
    }

    if (sessionIdRef.current && user?.id) {
      const startTime = state.session?.startedAt || new Date();
      const durationSeconds = Math.round((Date.now() - startTime.getTime()) / 1000);

      await supabase
        .from('farmer_copilot_sessions')
        .update({
          ended_at: new Date().toISOString(),
          duration_seconds: durationSeconds,
          // `?? null`, não `|| 'neutro'`: uma sessão cujas análises TODAS
          // falharam terminaria gravada como "neutra" — medição inventada sobre
          // uma conversa que ninguém leu. A coluna é nullable de propósito.
          final_direction: state.currentAnalysis?.direction ?? null,
          final_intent: state.currentAnalysis?.intent || null,
          final_phase: state.currentAnalysis?.phase || null,
          suggestions_shown: state.suggestionsShown,
          suggestions_used: state.suggestionsUsed,
          result: 'finalizado',
        })
        .eq('id', sessionIdRef.current);
    }

    sessionIdRef.current = null;
    setState(prev => ({
      ...prev,
      isActive: false,
      session: null,
    }));
  }, [user, state.session, state.currentAnalysis, state.suggestionsShown, state.suggestionsUsed]);

  // Add transcript entry
  const addTranscript = useCallback((text: string, isPartial: boolean = false) => {
    if (!text.trim()) return;

    setState(prev => {
      // If partial, update last partial entry
      if (isPartial) {
        const lastIdx = prev.transcript.findIndex(t => t.isPartial);
        if (lastIdx >= 0) {
          const updated = [...prev.transcript];
          updated[lastIdx] = { ...updated[lastIdx], text, timestamp: new Date() };
          return { ...prev, transcript: updated };
        }
      }

      const entry: TranscriptEntry = {
        id: crypto.randomUUID(),
        text,
        speaker: 'unknown',
        timestamp: new Date(),
        isPartial,
      };

      // Remove old partial if committing
      const filtered = isPartial ? prev.transcript : prev.transcript.filter(t => !t.isPartial);
      return { ...prev, transcript: [...filtered, entry] };
    });
  }, []);

  // Trigger AI analysis
  const triggerAnalysis = useCallback(async () => {
    setState(prev => {
      const fullText = prev.transcript
        .filter(t => !t.isPartial)
        .map(t => t.text)
        .join(' ');

      if (fullText.length < MIN_TRANSCRIPT_LENGTH || fullText === lastAnalyzedRef.current) {
        return prev;
      }

      // Cota estourada: não dispara até a janela virar. Sem esta guarda o tick
      // de 8s vira um martelo contra um limite que não cede — e o `catch`
      // adiante solta `lastAnalyzedRef` de propósito, o que aqui realimentaria
      // o loop a cada tick. O aviso na tela só sai quando uma análise VOLTA a
      // funcionar (abaixo), não no relógio: some porque funcionou, não porque
      // o tempo passou.
      if (cotaBloqueadaAteRef.current > Date.now()) {
        return prev;
      }
      cotaBloqueadaAteRef.current = 0;

      lastAnalyzedRef.current = fullText;

      // Fire async analysis
      (async () => {
        const seq = ++analiseSeqRef.current;
        setState(s => ({ ...s, isAnalyzing: true }));
        try {
          // invokeFunction (e não o invoke cru) para o motivo REAL da edge —
          // créditos esgotados, análise não utilizável — chegar até aqui em vez
          // do genérico "non-2xx status code".
          const payload = await invokeFunction<CopilotAnalyzeResponse>('copilot-analyze', {
            transcript: fullText.slice(-2000), // Last 2000 chars
            customerContext: prev.session?.customerContext,
            currentPhase: prev.currentAnalysis?.phase,
            currentIntent: prev.currentAnalysis?.intent,
            bundleContext: prev.session?.bundleContext,
          });

          // Sem default fabricado. Os `|| 'indiferenca'` / `|| 'neutro'` /
          // `|| 0` daqui não eram cosméticos: o resultado é GRAVADO em
          // farmer_copilot_events, então "indiferença" e confiança 0 viravam
          // histórico com cara de medição — sobre uma conversa que a IA não
          // conseguiu ler. A edge agora responde 422 quando não tem leitura;
          // se ainda assim vier incompleta, não exibimos nada.
          if (
            !payload?.intent || !payload.phase || !payload.direction ||
            !payload.suggestion || !payload.suggestion_type ||
            typeof payload.confidence !== 'number'
          ) {
            throw new Error('Análise incompleta');
          }

          const analysis: CopilotAnalysis = {
            intent: payload.intent,
            phase: payload.phase,
            direction: payload.direction,
            directionReasons: payload.direction_reasons || [],
            suggestion: payload.suggestion,
            suggestionType: payload.suggestion_type,
            confidence: payload.confidence,
          };

          // Chegou fora de ordem: uma análise mais nova já está na tela.
          if (seq !== analiseSeqRef.current) return;

          setState(s => ({
            ...s,
            currentAnalysis: analysis,
            analysisHistory: [...s.analysisHistory, analysis],
            isAnalyzing: false,
            analiseObsoleta: false,
            // Voltou a funcionar: é este o sinal que apaga o aviso de cota.
            avisoCota: null,
            suggestionsShown: s.suggestionsShown + 1,
          }));

          // Log event
          if (sessionIdRef.current) {
            await supabase.from('farmer_copilot_events').insert({
              session_id: sessionIdRef.current,
              event_type: 'suggestion',
              event_data: {
                intent: analysis.intent,
                phase: analysis.phase,
                direction: analysis.direction,
                confidence: analysis.confidence,
                suggestion_type: analysis.suggestionType,
              },
              transcript_snippet: fullText.slice(-200),
              suggestion_text: analysis.suggestion,
            });
          }
        } catch (err) {
          console.error('Analysis error:', err);

          // 429 = a COTA de IA desta usuária acabou. É diferente em espécie de
          // uma falha transitória: retentar não resolve, só gasta requisição —
          // e antes disto o erro morria no console, com o painel seguindo em
          // "AO VIVO" e ninguém sabendo por que as sugestões pararam.
          const cotaEstourada = err instanceof EdgeFunctionError && err.status === 429;
          if (cotaEstourada) {
            const esperaMs = err.retryAfterSeconds
              ? err.retryAfterSeconds * 1000
              : ESPERA_COTA_PADRAO_MS;
            cotaBloqueadaAteRef.current = Date.now() + esperaMs;
            setState(s => ({
              ...s,
              isAnalyzing: false,
              analiseObsoleta: s.currentAnalysis !== null,
              // A mensagem da edge já explica qual limite e quando volta.
              avisoCota: err.message,
            }));
            return;
          }

          // Solta o texto para o próximo tick TENTAR DE NOVO. Sem isto o
          // copiloto morre calado: `lastAnalyzedRef` já foi marcado antes da
          // chamada, então uma falha (422, rede) faria todos os ticks seguintes
          // pularem o mesmo trecho — e a tela seguiria em "AO VIVO" exibindo a
          // sugestão anterior como se fosse a leitura atual.
          if (lastAnalyzedRef.current === fullText) lastAnalyzedRef.current = '';
          setState(s => ({
            ...s,
            isAnalyzing: false,
            // A leitura na tela virou passado: marcar como obsoleta é o que
            // impede a vendedora de agir sobre uma direção que já mudou.
            analiseObsoleta: s.currentAnalysis !== null,
          }));
        }
      })();

      return prev;
    });
  }, []);

  // Mark suggestion as used
  const markSuggestionUsed = useCallback(async (suggestionText: string) => {
    setState(prev => ({ ...prev, suggestionsUsed: prev.suggestionsUsed + 1 }));

    if (sessionIdRef.current) {
      await supabase.from('farmer_copilot_events').insert({
        session_id: sessionIdRef.current,
        event_type: 'suggestion_used',
        suggestion_text: suggestionText,
        suggestion_used: true,
      });
    }
  }, []);

  // Record final result
  const recordResult = useCallback(async (result: string, revenue: number, margin: number) => {
    if (!sessionIdRef.current) return;

    await supabase
      .from('farmer_copilot_sessions')
      .update({
        result,
        revenue_generated: revenue,
        margin_generated: margin,
      })
      .eq('id', sessionIdRef.current);
  }, []);

  return {
    ...state,
    startSession,
    endSession,
    addTranscript,
    triggerAnalysis,
    markSuggestionUsed,
    recordResult,
  };
};
