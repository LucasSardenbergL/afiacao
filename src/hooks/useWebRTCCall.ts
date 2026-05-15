import { useCallback, useEffect, useRef, useState } from 'react';
import { SipClient } from '@/lib/sip/sip-client';
import type { SipCallState } from '@/lib/sip/types';
import { invokeFunction } from '@/lib/invoke-function';
import { useToast } from '@/hooks/use-toast';
import { normalizeBrPhone, formatBrPhone } from '@/lib/phone';
import { mixPrerollWithMic } from '@/lib/sip/audio-preroll';

export type WebRTCCallState =
  | 'idle' | 'connecting' | 'calling_origin' | 'calling_destination'
  | 'established' | 'finished' | 'noanswer' | 'busy' | 'failed' | 'error';

const SIP_TO_PUBLIC: Record<SipCallState, WebRTCCallState> = {
  idle: 'idle',
  registering: 'connecting',
  registered: 'idle',
  register_failed: 'error',
  calling: 'calling_destination',
  ringing: 'calling_destination',
  established: 'established',
  ending: 'established',
  ended: 'finished',
  failed: 'failed',
};

interface UseWebRTCCallReturn {
  callState: WebRTCCallState;
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
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
}

export function useWebRTCCall(): UseWebRTCCallReturn {
  const { toast } = useToast();
  const [callState, setCallState] = useState<WebRTCCallState>('idle');
  const [callDuration, setCallDuration] = useState(0);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<SipClient | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const rawMicRef = useRef<MediaStream | null>(null);
  const prerollCloseRef = useRef<(() => void) | null>(null);

  // Inicializa SipClient on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const creds = await invokeFunction<{
          wsUri: string; sipDomain: string; username: string; password: string;
        }>('nvoip-sip-creds', {});
        if (cancelled) return;

        const client = new SipClient(creds);
        clientRef.current = client;

        client.on('stateChange', (s) => setCallState(SIP_TO_PUBLIC[s]));
        client.on('localStream', (s) => setLocalStream(s));
        client.on('remoteStream', (s) => setRemoteStream(s));
        client.on('error', (e) => {
          setError(e.message);
          toast({ title: 'Erro WebRTC', description: e.message, variant: 'destructive' });
        });

        client.connect();
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Falha ao inicializar WebRTC';
        setError(msg);
        setCallState('error');
      }
    })();

    return () => {
      cancelled = true;
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
      cleanupAudioResources();
      clientRef.current?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Duration timer durante chamada estabelecida
  useEffect(() => {
    if (callState === 'established' && !durationTimerRef.current) {
      durationTimerRef.current = window.setInterval(() => {
        setCallDuration((d) => d + 1);
      }, 1000);
    } else if (callState !== 'established' && durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
  }, [callState]);

  function cleanupAudioResources() {
    if (prerollCloseRef.current) {
      try { prerollCloseRef.current(); } catch { /* noop */ }
      prerollCloseRef.current = null;
    }
    if (rawMicRef.current) {
      for (const track of rawMicRef.current.getTracks()) {
        track.stop();
      }
      rawMicRef.current = null;
    }
  }

  const makeCall = useCallback(async (phoneNumber: string) => {
    setError(null);
    setCallDuration(0);

    const normalized = normalizeBrPhone(phoneNumber);
    if (normalized.length < 10) {
      const msg = 'Telefone inválido. É necessário DDD + número.';
      setError(msg);
      toast({ title: 'Erro', description: msg, variant: 'destructive' });
      return;
    }

    if (!clientRef.current) {
      setError('WebRTC não inicializado');
      return;
    }

    try {
      const rawMic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      rawMicRef.current = rawMic;

      const prerollUrl = import.meta.env.VITE_NVOIP_SIP_PREROLL_URL as string | undefined;
      let streamForCall: MediaStream = rawMic;
      if (prerollUrl) {
        const mix = await mixPrerollWithMic(prerollUrl, rawMic);
        streamForCall = mix.stream;
        prerollCloseRef.current = mix.close;
      }

      clientRef.current.makeCall(normalized, streamForCall);
      toast({ title: '📞 Chamada iniciada', description: `Ligando para ${formatBrPhone(normalized)}...` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao iniciar chamada';
      setError(msg);
      cleanupAudioResources();
      toast({ title: 'Erro na chamada', description: msg, variant: 'destructive' });
    }
  }, [toast]);

  const endCall = useCallback(async () => {
    clientRef.current?.hangUp();
    cleanupAudioResources();
    toast({ title: 'Chamada encerrada' });
  }, [toast]);

  const isActive = !['idle', 'finished', 'noanswer', 'busy', 'failed', 'error'].includes(callState);
  const isConnecting = callState === 'connecting';
  const isRinging = callState === 'calling_origin' || callState === 'calling_destination';
  const isEstablished = callState === 'established';
  const isFinished = ['finished', 'noanswer', 'busy', 'failed'].includes(callState);

  return {
    callState,
    callId: null,
    callDuration,
    audioLink: null,
    makeCall,
    endCall,
    isActive, isConnecting, isRinging, isEstablished, isFinished,
    error,
    localStream,
    remoteStream,
  };
}
