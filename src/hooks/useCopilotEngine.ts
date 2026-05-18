import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
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
  suggestionsShown: number;
  suggestionsUsed: number;
}

const ANALYSIS_INTERVAL_MS = 8000; // Analyze every 8 seconds of new speech
const MIN_TRANSCRIPT_LENGTH = 20;

export const useCopilotEngine = () => {
  const { user } = useAuth();
  const [state, setState] = useState<CopilotState>({
    isActive: false,
    session: null,
    transcript: [],
    currentAnalysis: null,
    analysisHistory: [],
    isAnalyzing: false,
    suggestionsShown: 0,
    suggestionsUsed: 0,
  });

  const analysisTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastAnalyzedRef = useRef<string>('');
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

    setState(prev => ({
      ...prev,
      isActive: true,
      session,
      transcript: [],
      currentAnalysis: null,
      analysisHistory: [],
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
          final_direction: state.currentAnalysis?.direction || 'neutro',
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

      lastAnalyzedRef.current = fullText;

      // Fire async analysis
      (async () => {
        setState(s => ({ ...s, isAnalyzing: true }));
        try {
          const { data, error } = await supabase.functions.invoke('copilot-analyze', {
            body: {
              transcript: fullText.slice(-2000), // Last 2000 chars
              customerContext: prev.session?.customerContext,
              currentPhase: prev.currentAnalysis?.phase,
              currentIntent: prev.currentAnalysis?.intent,
              bundleContext: prev.session?.bundleContext,
            },
          });

          if (error || !data) throw error || new Error('No data');

          const payload = data as CopilotAnalyzeResponse;
          const analysis: CopilotAnalysis = {
            intent: payload.intent || 'indiferenca',
            phase: payload.phase || 'abertura',
            direction: payload.direction || 'neutro',
            directionReasons: payload.direction_reasons || [],
            suggestion: payload.suggestion || '',
            suggestionType: payload.suggestion_type || 'pergunta_diagnostica',
            confidence: payload.confidence || 0,
          };

          setState(s => ({
            ...s,
            currentAnalysis: analysis,
            analysisHistory: [...s.analysisHistory, analysis],
            isAnalyzing: false,
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
          setState(s => ({ ...s, isAnalyzing: false }));
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
