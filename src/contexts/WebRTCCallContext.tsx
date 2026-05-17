import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { SipClient } from '@/lib/sip/sip-client';
import type { SipCallState } from '@/lib/sip/types';
import { invokeFunction } from '@/lib/invoke-function';
import { useToast } from '@/hooks/use-toast';
import { normalizeBrPhone, formatBrPhone } from '@/lib/phone';
import { mixPrerollWithMic } from '@/lib/sip/audio-preroll';
import { useTranscription } from '@/hooks/useTranscription';
import type { TranscriptTurn, TranscriptionStatus } from '@/lib/transcription/types';

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

export interface WebRTCCallContextValue {
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
  // NEW in PR1.6:
  isMuted: boolean;
  toggleMute: () => void;
  /** true durante reprodução do pre-roll LGPD; false antes/depois */
  prerollPlaying: boolean;
  /** timestamp (Date.now()) em que o preroll termina; null se sem preroll */
  prerollEndsAt: number | null;
  /** Stream raw do mic do vendedor (sem preroll mixado).
   *  Exposto pra TranscriptionEngine usar como canal "vendedor". */
  vendorMicStream: MediaStream | null;
  /** Status da transcrição ao vivo (idle/connecting/active/error) */
  transcriptionStatus: TranscriptionStatus;
  /** Turnos de transcrição em ordem cronológica */
  transcriptionTurns: TranscriptTurn[];
  /** Mensagem de erro da transcrição, se houver */
  transcriptionError: string | null;
}

const WebRTCCallContext = createContext<WebRTCCallContextValue | null>(null);

interface ProviderProps {
  children: ReactNode;
}

export function WebRTCCallProvider({ children }: ProviderProps) {
  const { toast } = useToast();
  const [callState, setCallState] = useState<WebRTCCallState>('idle');
  const [callDuration, setCallDuration] = useState(0);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [prerollPlaying, setPrerollPlaying] = useState(false);
  const [prerollEndsAt, setPrerollEndsAt] = useState<number | null>(null);
  const [vendorMicStream, setVendorMicStream] = useState<MediaStream | null>(null);

  const clientRef = useRef<SipClient | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const rawMicRef = useRef<MediaStream | null>(null);
  const prerollCloseRef = useRef<(() => void) | null>(null);
  const prerollPlayRef = useRef<(() => void) | null>(null);
  const prerollDurationRef = useRef<number | null>(null);
  const prerollFinishTimerRef = useRef<number | null>(null);
  const prerollUrl = (import.meta.env.VITE_NVOIP_SIP_PREROLL_URL as string | undefined);

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

  /**
   * Timing fix: dispara o pre-roll APENAS quando o cliente atende ('established').
   * Se chamássemos play() em makeCall (antes do INVITE), o áudio tocaria durante
   * a fase de ringing — quando RTP ainda não flui — e o cliente perderia o aviso.
   * O play() é idempotente, então re-renders durante 'established' não duplicam.
   */
  useEffect(() => {
    if (callState === 'established' && prerollPlayRef.current) {
      prerollPlayRef.current();
      prerollPlayRef.current = null;

      const duration = prerollDurationRef.current;
      if (duration && duration > 0) {
        setPrerollPlaying(true);
        setPrerollEndsAt(Date.now() + duration * 1000);

        // Auto-encerrar UI feedback quando termina
        prerollFinishTimerRef.current = window.setTimeout(() => {
          setPrerollPlaying(false);
          setPrerollEndsAt(null);
          prerollFinishTimerRef.current = null;
        }, duration * 1000);
      }
    }
  }, [callState]);

  function cleanupAudioResources() {
    setVendorMicStream(null);
    if (prerollFinishTimerRef.current) {
      clearTimeout(prerollFinishTimerRef.current);
      prerollFinishTimerRef.current = null;
    }
    setPrerollPlaying(false);
    setPrerollEndsAt(null);
    prerollDurationRef.current = null;
    prerollPlayRef.current = null;
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

    cleanupAudioResources();

    try {
      const rawMic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      rawMicRef.current = rawMic;
      setVendorMicStream(rawMic);

      let streamForCall: MediaStream = rawMic;
      if (prerollUrl) {
        const mix = await mixPrerollWithMic(prerollUrl, rawMic);
        streamForCall = mix.stream;
        // play() é disparado pelo useEffect ao detectar callState === 'established'
        prerollPlayRef.current = mix.play;
        prerollCloseRef.current = mix.close;
        prerollDurationRef.current = mix.durationSeconds;
      }

      clientRef.current.makeCall(normalized, streamForCall);
      toast({ title: '📞 Chamada iniciada', description: `Ligando para ${formatBrPhone(normalized)}...` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao iniciar chamada';
      setError(msg);
      cleanupAudioResources();
      toast({ title: 'Erro na chamada', description: msg, variant: 'destructive' });
    }
  }, [toast, prerollUrl]);

  const endCall = useCallback(async () => {
    clientRef.current?.hangUp();
    cleanupAudioResources();
    setIsMuted(false);
    toast({ title: 'Chamada encerrada' });
  }, [toast]);

  const toggleMute = useCallback(() => {
    if (!clientRef.current) return;
    if (clientRef.current.isMuted()) {
      clientRef.current.unmute();
      setIsMuted(false);
    } else {
      clientRef.current.mute();
      setIsMuted(true);
    }
  }, []);

  const isActive = !['idle', 'finished', 'noanswer', 'busy', 'failed', 'error'].includes(callState);
  const isConnecting = callState === 'connecting';
  const isRinging = callState === 'calling_origin' || callState === 'calling_destination';
  const isEstablished = callState === 'established';
  const isFinished = ['finished', 'noanswer', 'busy', 'failed'].includes(callState);

  const transcription = useTranscription({
    vendorStream: vendorMicStream,
    clientStream: remoteStream,
    enabled: callState === 'established',
  });

  const value: WebRTCCallContextValue = {
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
    isMuted,
    toggleMute,
    prerollPlaying,
    prerollEndsAt,
    vendorMicStream,
    transcriptionStatus: transcription.status,
    transcriptionTurns: transcription.turns,
    transcriptionError: transcription.error,
  };

  return <WebRTCCallContext.Provider value={value}>{children}</WebRTCCallContext.Provider>;
}

// Provider + hook colocados no mesmo arquivo por design (acoplamento forte:
// hook só faz sentido com o Provider que define a shape). Splitting iria
// adicionar indireção sem valor. Fast refresh ainda funciona pro Provider.
// eslint-disable-next-line react-refresh/only-export-components
export function useWebRTCCallContext(): WebRTCCallContextValue {
  const ctx = useContext(WebRTCCallContext);
  if (!ctx) {
    throw new Error('useWebRTCCallContext must be used within a WebRTCCallProvider');
  }
  return ctx;
}
