import { useEffect, useRef, useState } from 'react';
import { TranscriptionEngine } from '@/lib/transcription/transcription-engine';
import type { TranscriptTurn, TranscriptionStatus } from '@/lib/transcription/types';
import { invokeFunction } from '@/lib/invoke-function';

interface UseTranscriptionOptions {
  vendorStream: MediaStream | null;
  clientStream: MediaStream | null;
  /** Quando false, hook fica idle (não inicia engine, não consome créditos Deepgram) */
  enabled: boolean;
}

export interface UseTranscriptionReturn {
  status: TranscriptionStatus;
  turns: TranscriptTurn[];
  error: string | null;
}

/**
 * Hook React que gerencia transcrição ao vivo via TranscriptionEngine.
 *
 * Quando `enabled=true` E ambos os streams existem: fetcha token Deepgram,
 * inicia o engine e popula `turns` em tempo real.
 *
 * Quando `enabled=false` OU algum stream ausente: noop (engine para se estava ativo).
 *
 * Cleanup: `stop()` do engine roda em unmount ou quando enabled volta a false.
 *
 * Estratégia: só dispara startup quando enabled vira true (e streams existem).
 * Não relança se enabled segue true mas refs de stream mudam — assume que o caller
 * mantém streams estáveis durante uma chamada ativa (WebRTCCallContext faz isso).
 */
export function useTranscription(opts: UseTranscriptionOptions): UseTranscriptionReturn {
  const { vendorStream, clientStream, enabled } = opts;
  const [status, setStatus] = useState<TranscriptionStatus>('idle');
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const engineRef = useRef<TranscriptionEngine | null>(null);

  // Mantém refs atualizadas dos streams para o startup async usar a versão mais recente
  const vendorStreamRef = useRef<MediaStream | null>(vendorStream);
  const clientStreamRef = useRef<MediaStream | null>(clientStream);
  vendorStreamRef.current = vendorStream;
  clientStreamRef.current = clientStream;

  useEffect(() => {
    // Caso desabilitado / sem streams: para engine e zera status
    if (!enabled || !vendorStream || !clientStream) {
      if (engineRef.current) {
        engineRef.current.stop();
        engineRef.current = null;
      }
      setStatus('idle');
      return;
    }

    // Se engine já existe (mesma sessão), nada a fazer
    if (engineRef.current) {
      return;
    }

    let cancelled = false;
    // Nova sessão: zera os turns/erro da chamada ANTERIOR. Sem isto, a transcrição de
    // uma ligação vaza para a próxima (o Provider WebRTC é global e não desmonta entre
    // chamadas) — persistiria conversa do cliente A em `farmer_calls` do cliente B e
    // contaminaria os sinais/CRM (LGPD). Seguro: só executa quando engineRef é null,
    // nunca no meio de uma chamada ativa.
    setTurns([]);
    setStatus('connecting');
    setError(null);

    (async () => {
      try {
        const { key } = await invokeFunction<{ key: string; expiresAt: string }>(
          'deepgram-token',
          {}
        );
        if (cancelled) return;

        const engine = new TranscriptionEngine({ apiKey: key });
        engineRef.current = engine;

        engine.on('turn', (turn) => {
          setTurns((prev) => {
            const idx = prev.findIndex((t) => t.id === turn.id);
            if (idx >= 0) {
              const next = [...prev];
              // Preserva startedAt original do primeiro interim
              next[idx] = { ...turn, startedAt: prev[idx].startedAt };
              return next;
            }
            return [...prev, turn];
          });
        });

        engine.on('error', (err) => {
          setError(err.message);
          setStatus('error');
        });

        const vs = vendorStreamRef.current;
        const cs = clientStreamRef.current;
        if (!vs || !cs) {
          // Streams sumiram durante o fetch do token — aborta
          engine.stop();
          engineRef.current = null;
          setStatus('idle');
          return;
        }
        engine.start({ vendorStream: vs, clientStream: cs });
        setStatus('active');
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Erro na transcrição';
        setError(msg);
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Cleanup definitivo no unmount
  useEffect(() => {
    return () => {
      if (engineRef.current) {
        engineRef.current.stop();
        engineRef.current = null;
      }
    };
  }, []);

  return { status, turns, error };
}
