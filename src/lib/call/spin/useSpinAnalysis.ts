import { useEffect, useRef, useState } from 'react';
import { invokeFunction } from '@/lib/invoke-function';
import type { TranscriptTurn } from '@/lib/transcription/types';
import type { SpinAnalysis, SpinAnalysisStatus, TranscriptTurnLite } from '@/lib/call/spin/types';

interface UseSpinAnalysisOptions {
  turns: TranscriptTurn[];
  /** Quando false, não dispara análise (não consome créditos Anthropic). */
  enabled: boolean;
  /** Delay de debounce após último turno final do cliente (default 3000ms). */
  debounceMs?: number;
}

export interface UseSpinAnalysisReturn {
  status: SpinAnalysisStatus;
  analysis: SpinAnalysis | null;
  error: string | null;
}

/**
 * Hook que orquestra análise SPIN ao vivo.
 *
 * Trigger: cada vez que detecta novo turno FINAL do CLIENTE, agenda análise
 * com debounce de 3s. Se outro turno final do cliente chegar antes do timer
 * disparar, reseta o timer (debounce clássico). Turnos do VENDEDOR e turnos
 * INTERIM não disparam — só consomem créditos sem agregar info nova.
 *
 * Quando dispara: chama edge function `claude-spin-analyze` com TODOS os
 * turnos acumulados (Claude analisa o contexto completo). Atualiza `analysis`
 * com a resposta. Erros entram em `status='error'` mas não interrompem a chamada.
 */
export function useSpinAnalysis(opts: UseSpinAnalysisOptions): UseSpinAnalysisReturn {
  const { turns, enabled, debounceMs = 3000 } = opts;
  const [status, setStatus] = useState<SpinAnalysisStatus>('idle');
  const [analysis, setAnalysis] = useState<SpinAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<number | null>(null);
  const lastTriggeringTurnIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    // Encontra o último turno FINAL do CLIENTE
    const lastClienteFinal = [...turns].reverse().find(
      (t) => t.speaker === 'cliente' && t.isFinal
    );
    if (!lastClienteFinal) return;

    // Se já agendamos análise pra esse mesmo turno, não reagendar
    if (lastTriggeringTurnIdRef.current === lastClienteFinal.id && timerRef.current === null) {
      // Já processamos este turno
      return;
    }

    // Cancela timer anterior (debounce)
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    lastTriggeringTurnIdRef.current = lastClienteFinal.id;

    timerRef.current = window.setTimeout(async () => {
      timerRef.current = null;
      setStatus('analyzing');
      setError(null);

      try {
        // Converte pros tipos lite (sem ids internos)
        const turnsLite: TranscriptTurnLite[] = turns.map((t) => ({
          speaker: t.speaker,
          text: t.text,
          isFinal: t.isFinal,
          startedAt: t.startedAt,
        }));

        const response = await invokeFunction<{ analysis: SpinAnalysis; usage: unknown }>(
          'claude-spin-analyze',
          { turns: turnsLite }
        );
        setAnalysis(response.analysis);
        setStatus('ready');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro na análise SPIN';
        setError(msg);
        setStatus('error');
      }
    }, debounceMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [turns, enabled, debounceMs]);

  return { status, analysis, error };
}
