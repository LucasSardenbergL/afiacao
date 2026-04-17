import { useState, useRef, useCallback, useEffect } from 'react';
import { invokeFunction } from '@/lib/invoke-function';
import { useToast } from '@/hooks/use-toast';
import { normalizeBrPhone, formatBrPhone } from '@/lib/phone';

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
  makeCall: (phoneNumber: string) => Promise<void>;
  endCall: () => Promise<void>;
  isActive: boolean;
  isConnecting: boolean;
  isRinging: boolean;
  isEstablished: boolean;
  isFinished: boolean;
  error: string | null;
}

export function useNvoipCall(): UseNvoipCallReturn {
  const { toast } = useToast();
  const [callState, setCallState] = useState<NvoipCallState>('idle');
  const [callId, setCallId] = useState<string | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  const [audioLink, setAudioLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollingRef = useRef<number | null>(null);
  const durationRef = useRef<number | null>(null);

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

        // Stop polling on terminal states
        const terminalStates: NvoipCallState[] = ['finished', 'noanswer', 'busy', 'failed'];
        if (terminalStates.includes(state)) {
          stopPolling();

          if (data.talkingDurationSeconds) {
            setCallDuration(data.talkingDurationSeconds);
          }
        }
      } catch (err) {
        console.error('Error polling call status:', err);
      }
    },
    [stopPolling]
  );

  const makeCall = useCallback(
    async (phoneNumber: string) => {
      setError(null);
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
        setCallState((data.state as NvoipCallState) || 'calling_origin');

        // Start polling every 2 seconds
        pollingRef.current = window.setInterval(() => {
          pollCallStatus(data.callId);
        }, 2000);

        toast({ title: '📞 Chamada iniciada', description: `Ligando para ${formatBrPhone(normalized)}...` });
      } catch (err: any) {
        setCallState('error');
        setError(err.message || 'Erro ao realizar chamada');
        toast({
          title: 'Erro na chamada',
          description: err.message || 'Não foi possível realizar a chamada',
          variant: 'destructive',
        });
      }
    },
    [pollCallStatus, toast]
  );

  const endCall = useCallback(async () => {
    if (!callId) return;

    try {
      await invokeFunction('nvoip-calls', { action: 'end_call', callId });
      setCallState('finished');
      stopPolling();
      toast({ title: 'Chamada encerrada' });
    } catch (err: any) {
      console.error('Error ending call:', err);
      toast({
        title: 'Erro ao encerrar',
        description: err.message,
        variant: 'destructive',
      });
    }
  }, [callId, stopPolling, toast]);

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
