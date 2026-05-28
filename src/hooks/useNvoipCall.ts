import { useState, useRef, useCallback, useEffect } from 'react';
import { invokeFunction } from '@/lib/invoke-function';
import { toast } from 'sonner';
import { normalizeBrPhone, formatBrPhone } from '@/lib/phone';
import { logger } from '@/lib/logger';

// Após N polls consecutivos falhando (rede caiu, função fora do ar), paramos de
// pollar e marcamos erro — em vez de bater na Edge Function a cada 2s pra sempre.
const MAX_CONSECUTIVE_POLL_ERRORS = 5;

export type NvoipCallState =
  | 'idle'
  | 'connecting'
  | 'calling_origin'
  | 'calling_destination'
  | 'established'
  | 'finished'
  | 'noanswer'
  | 'busy'
  | 'failed'
  | 'error';

interface NvoipCallStatus {
  state: NvoipCallState;
  talkingDurationSeconds?: number;
  linkAudio?: string;
}

interface UseNvoipCallReturn {
  callState: NvoipCallState;
  callId: string | null;
  callDuration: number;
  audioLink: string | null;
  makeCall: (phoneNumber: string, opts?: { forceRecord?: boolean }) => Promise<void>;
  endCall: () => Promise<void>;
  isActive: boolean;
  isConnecting: boolean;
  isRinging: boolean;
  isEstablished: boolean;
  isFinished: boolean;
  error: string | null;
}

export function useNvoipCall(): UseNvoipCallReturn {
  const [callState, setCallState] = useState<NvoipCallState>('idle');
  const [callId, setCallId] = useState<string | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  const [audioLink, setAudioLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollingRef = useRef<number | null>(null);
  const durationRef = useRef<number | null>(null);
  const pollErrorsRef = useRef(0);
  // ID da chamada cujo polling é o "vivo". Respostas de poll de uma chamada
  // anterior (já encerrada) que chegam atrasadas são descartadas comparando
  // contra este ref — senão poderiam setar estado terminal e parar o polling
  // de uma chamada nova que começou no intervalo.
  const activeCallIdRef = useRef<string | null>(null);
  // Espelha callState pra leitura síncrona no guard de concorrência (sem stale closure).
  const callStateRef = useRef<NvoipCallState>('idle');
  callStateRef.current = callState;

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    if (durationRef.current) {
      clearInterval(durationRef.current);
      durationRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const pollCallStatus = useCallback(
    async (id: string) => {
      try {
        const data = await invokeFunction<NvoipCallStatus>('nvoip-calls', {
          action: 'check_call',
          callId: id,
        });

        // Resposta atrasada de uma chamada que já não é a ativa (ex.: a chamada
        // foi encerrada e outra começou). Descarta pra não sobrescrever o estado
        // da chamada atual nem parar o polling dela.
        if (id !== activeCallIdRef.current) return;

        pollErrorsRef.current = 0;

        const state = data.state || 'error';
        setCallState(state);

        if (data.linkAudio) {
          setAudioLink(data.linkAudio);
        }

        // Start duration counter when established
        if (state === 'established' && !durationRef.current) {
          durationRef.current = window.setInterval(() => {
            setCallDuration((d) => d + 1);
          }, 1000);
        }

        // Stop polling on terminal states ('error' incluído: estado final do backend
        // também encerra o polling, senão batíamos na Edge Function a cada 2s pra sempre).
        const terminalStates: NvoipCallState[] = ['finished', 'noanswer', 'busy', 'failed', 'error'];
        if (terminalStates.includes(state)) {
          stopPolling();

          if (data.talkingDurationSeconds) {
            setCallDuration(data.talkingDurationSeconds);
          }
        }
      } catch (err) {
        pollErrorsRef.current += 1;
        logger.warn('Falha ao consultar status da chamada Nvoip', {
          callId: id,
          consecutiveErrors: pollErrorsRef.current,
          error: err instanceof Error ? err.message : String(err),
        });
        if (pollErrorsRef.current >= MAX_CONSECUTIVE_POLL_ERRORS) {
          stopPolling();
          setCallState('error');
          setError('Conexão perdida ao acompanhar a chamada');
        }
      }
    },
    [stopPolling]
  );

  const makeCall = useCallback(
    // opts.forceRecord é aceito pra paridade de assinatura com o backend WebRTC
    // (useCallBackend retorna a união dos dois). Nvoip ignora por ora — a gravação
    // do lado Nvoip é controlada server-side na própria Edge Function.
    async (phoneNumber: string, _opts?: { forceRecord?: boolean }) => {
      // Guard de concorrência: já há uma chamada em andamento (conectando/tocando/em curso).
      // Sem isso, dois cliques (ou "religar" do histórico durante uma chamada) abririam
      // sessões paralelas com polling concorrente.
      const active = !['idle', 'finished', 'noanswer', 'busy', 'failed', 'error'].includes(
        callStateRef.current
      );
      if (active) {
        toast.info('Já existe uma chamada em andamento');
        return;
      }

      stopPolling();
      pollErrorsRef.current = 0;
      // Invalida qualquer poll em voo de uma chamada anterior (a resposta dele
      // será descartada pelo guard `id !== activeCallIdRef.current`).
      activeCallIdRef.current = null;
      setError(null);
      // Seta o ref junto com o state pra fechar a janela síncrona do guard de
      // concorrência: dois disparos no mesmo tick passam a ver 'connecting'.
      callStateRef.current = 'connecting';
      setCallState('connecting');
      setCallDuration(0);
      setAudioLink(null);

      try {
        const normalized = normalizeBrPhone(phoneNumber);
        if (normalized.length < 10) {
          throw new Error('Telefone inválido. É necessário DDD + número (ex: 37999999999).');
        }

        const data = await invokeFunction<{ success: boolean; callId: string; state: string }>(
          'nvoip-calls',
          { action: 'make_call', called: normalized }
        );

        if (!data.success || !data.callId) {
          throw new Error('Falha ao iniciar chamada');
        }

        setCallId(data.callId);
        activeCallIdRef.current = data.callId;
        setCallState((data.state as NvoipCallState) || 'calling_origin');

        // Start polling every 2 seconds
        pollingRef.current = window.setInterval(() => {
          pollCallStatus(data.callId);
        }, 2000);

        toast.success('📞 Chamada iniciada', { description: `Ligando para ${formatBrPhone(normalized)}...` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        setCallState('error');
        setError(msg || 'Erro ao realizar chamada');
        toast.error('Erro na chamada', {
          description: msg || 'Não foi possível realizar a chamada',
        });
      }
    },
    [pollCallStatus, stopPolling]
  );

  const endCall = useCallback(async () => {
    if (!callId) return;

    try {
      await invokeFunction('nvoip-calls', { action: 'end_call', callId });
      setCallState('finished');
      stopPolling();
      // Não queremos mais resultados de poll desta chamada encerrada.
      activeCallIdRef.current = null;
      toast.success('Chamada encerrada');
    } catch (err) {
      logger.error('Erro ao encerrar chamada Nvoip', {
        callId,
        error: err instanceof Error ? err.message : String(err),
      });
      toast.error('Erro ao encerrar', {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [callId, stopPolling]);

  const isActive = !['idle', 'finished', 'noanswer', 'busy', 'failed', 'error'].includes(callState);
  const isConnecting = callState === 'connecting';
  const isRinging = callState === 'calling_origin' || callState === 'calling_destination';
  const isEstablished = callState === 'established';
  const isFinished = ['finished', 'noanswer', 'busy', 'failed'].includes(callState);

  return {
    callState,
    callId,
    callDuration,
    audioLink,
    makeCall,
    endCall,
    isActive,
    isConnecting,
    isRinging,
    isEstablished,
    isFinished,
    error,
  };
}
