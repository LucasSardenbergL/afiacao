import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { SipClient } from '@/lib/sip/sip-client';
import type { SipCallState, IncomingCallInfo } from '@/lib/sip/types';
import { invokeFunction } from '@/lib/invoke-function';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { normalizeBrPhone, formatBrPhone } from '@/lib/phone';
import { mixPrerollWithMic } from '@/lib/sip/audio-preroll';
import { useTranscription } from '@/hooks/useTranscription';
import type { TranscriptTurn, TranscriptionStatus } from '@/lib/transcription/types';
import { useSpinAnalysis } from '@/hooks/useSpinAnalysis';
import type { SpinAnalysis, SpinAnalysisStatus, CustomerCapture } from '@/lib/spin/types';
import { resolveCustomerByPhone } from '@/lib/call-session/resolve-customer';
import { buildSessionPayload } from '@/lib/call-session/build-session-payload';
import { emptyCapture, mergeCustomerCapture, captureFilledCount } from '@/lib/customer-capture/merge';

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
  /** Análise SPIN ao vivo da conversa atual. null se ainda não rodou. */
  spinAnalysis: SpinAnalysis | null;
  spinAnalysisStatus: SpinAnalysisStatus;
  spinAnalysisError: string | null;
  /** PR-INBOUND-CALLS: chamada inbound pendente esperando accept/reject */
  incomingCall: IncomingCallInfo | null;
  acceptIncoming: () => Promise<void>;
  rejectIncoming: () => void;
  /** PR-CAPTURE-A: dados cadastrais acumulados durante a chamada (Claude extrai) */
  customerCaptureBuffer: CustomerCapture;
  /** PR-CAPTURE-A: quantos campos significativos foram capturados (usado pra decidir wizard) */
  customerCaptureFilledCount: number;
  /** PR-CAPTURE-A: dados capturados da última chamada encerrada, pra wizard pós-call */
  lastCallCapture: { capture: CustomerCapture; phoneDialed: string; callId: string | null } | null;
  dismissLastCallCapture: () => void;
  /** PR-CAPTURE-A: vendedor pode editar buffer durante a chamada (sidebar) */
  updateCustomerCaptureBuffer: (patch: Partial<CustomerCapture>) => void;
}

const WebRTCCallContext = createContext<WebRTCCallContextValue | null>(null);

/**
 * Persiste a sessão de chamada em `farmer_calls` ao final.
 * Fire-and-forget: erros logam apenas, não interrompem o cleanup da chamada.
 * Definido fora do Provider pra não ser recriado a cada render.
 */
async function persistCallSession(opts: {
  startedAt: Date;
  endedAt: Date;
  turns: TranscriptTurn[];
  analyses: SpinAnalysis[];
  dialedPhone: string;
}): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { customerUserId, phoneDialed } = await resolveCustomerByPhone(opts.dialedPhone);

    const payload = buildSessionPayload({
      farmerId: user.id,
      customerUserId,
      phoneDialed,
      callBackend: 'webrtc',
      startedAt: opts.startedAt,
      endedAt: opts.endedAt,
      turns: opts.turns,
      analyses: opts.analyses,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await supabase.from('farmer_calls').insert(payload as any);
    if (error) {
      console.error('[WebRTCCallContext] persistCallSession insert failed:', error);
    }
  } catch (err) {
    console.error('[WebRTCCallContext] persistCallSession error:', err);
  }
}

interface ProviderProps {
  children: ReactNode;
}

export function WebRTCCallProvider({ children }: ProviderProps) {
  const [callState, setCallState] = useState<WebRTCCallState>('idle');
  const [callDuration, setCallDuration] = useState(0);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [prerollPlaying, setPrerollPlaying] = useState(false);
  const [prerollEndsAt, setPrerollEndsAt] = useState<number | null>(null);
  const [vendorMicStream, setVendorMicStream] = useState<MediaStream | null>(null);
  // PR-CAPTURE-A: buffer acumulador de dados cadastrais durante chamada
  const [customerCaptureBuffer, setCustomerCaptureBuffer] = useState<CustomerCapture>(emptyCapture);
  const [lastCallCapture, setLastCallCapture] = useState<{
    capture: CustomerCapture;
    phoneDialed: string;
    callId: string | null;
  } | null>(null);
  // PR-INBOUND-CALLS
  const [incomingCall, setIncomingCall] = useState<IncomingCallInfo | null>(null);

  const clientRef = useRef<SipClient | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const rawMicRef = useRef<MediaStream | null>(null);
  const prerollCloseRef = useRef<(() => void) | null>(null);
  const prerollPlayRef = useRef<(() => void) | null>(null);
  const prerollDurationRef = useRef<number | null>(null);
  const prerollFinishTimerRef = useRef<number | null>(null);
  const prerollUrl = (import.meta.env.VITE_NVOIP_SIP_PREROLL_URL as string | undefined);

  // PR4 — Refs pra persistência da sessão de chamada
  const analysisHistoryRef = useRef<SpinAnalysis[]>([]);
  const dialedPhoneRef = useRef<string>('');
  const callStartedAtRef = useRef<Date | null>(null);
  // Ref atualizado por effect pra evitar problema de hoisting com transcription
  // (transcription é declarado depois dos useCallbacks)
  const turnsRef = useRef<TranscriptTurn[]>([]);

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
        // PR-INBOUND-CALLS: emite quando chamada entra
        client.on('incomingCall', (info) => setIncomingCall(info));
        client.on('error', (e) => {
          setError(e.message);
          toast.error('Erro WebRTC', { description: e.message });
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
      toast.error('Erro', { description: msg });
      return;
    }

    if (!clientRef.current) {
      setError('WebRTC não inicializado');
      return;
    }

    // PR4 — Reset refs de sessão antes de iniciar nova chamada
    analysisHistoryRef.current = [];
    setCustomerCaptureBuffer(emptyCapture()); // PR-CAPTURE-A: reset buffer
    dialedPhoneRef.current = normalized;
    callStartedAtRef.current = new Date();

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
      toast.success('📞 Chamada iniciada', { description: `Ligando para ${formatBrPhone(normalized)}...` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao iniciar chamada';
      setError(msg);
      cleanupAudioResources();
      toast.error('Erro na chamada', { description: msg });
    }
  }, [prerollUrl]);

  const endCall = useCallback(async () => {
    // PR4 — Capturar snapshot ANTES de cleanup (refs/state ainda válidos).
    // Lê turns/analyses via refs pra evitar hoisting com `transcription` (declarado abaixo).
    const startedAt = callStartedAtRef.current;
    const turnsSnapshot = [...turnsRef.current];
    const analysesSnapshot = [...analysisHistoryRef.current];
    const dialedPhone = dialedPhoneRef.current;
    // PR-CAPTURE-A: snapshot do buffer pra wizard pós-call
    const captureSnapshot = customerCaptureBuffer;

    clientRef.current?.hangUp();
    cleanupAudioResources();
    setIsMuted(false);
    toast.success('Chamada encerrada');

    // Fire-and-forget — não bloqueia UI. Só persiste se houve conteúdo útil.
    if (startedAt && (turnsSnapshot.length > 0 || analysesSnapshot.length > 0)) {
      void persistCallSession({
        startedAt,
        endedAt: new Date(),
        turns: turnsSnapshot,
        analyses: analysesSnapshot,
        dialedPhone,
      });
    }

    // PR-CAPTURE-A: dispara wizard se cliente é novo (resolveCustomerByPhone retorna null)
    // E houve captura significativa (>=2 campos preenchidos)
    if (dialedPhone && captureFilledCount(captureSnapshot) >= 2) {
      void (async () => {
        const { customerUserId } = await resolveCustomerByPhone(dialedPhone);
        if (!customerUserId) {
          setLastCallCapture({
            capture: captureSnapshot,
            phoneDialed: dialedPhone,
            callId: null, // farmer_calls.id ainda não temos (persist é fire-and-forget); UI sem callId vinculará via phone match na criação
          });
        }
      })();
    }
  }, [customerCaptureBuffer]);

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

  // PR-INBOUND-CALLS: atende chamada pendente. Mesmo setup de áudio do makeCall (mic + preroll).
  const acceptIncoming = useCallback(async () => {
    if (!incomingCall || !clientRef.current) return;

    // Reset refs de sessão (mesma lógica do makeCall pro persist funcionar)
    analysisHistoryRef.current = [];
    dialedPhoneRef.current = incomingCall.phone;
    callStartedAtRef.current = new Date();

    cleanupAudioResources();

    try {
      const rawMic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      rawMicRef.current = rawMic;
      setVendorMicStream(rawMic);

      let streamForCall: MediaStream = rawMic;
      if (prerollUrl) {
        const mix = await mixPrerollWithMic(prerollUrl, rawMic);
        streamForCall = mix.stream;
        prerollPlayRef.current = mix.play;
        prerollCloseRef.current = mix.close;
        prerollDurationRef.current = mix.durationSeconds;
      }

      clientRef.current.acceptIncoming(streamForCall);
      const callerLabel = incomingCall.displayName ?? formatBrPhone(incomingCall.phone);
      setIncomingCall(null);
      toast.success('📞 Chamada atendida', { description: callerLabel });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao atender';
      setError(msg);
      cleanupAudioResources();
      setIncomingCall(null);
      toast.error('Erro ao atender chamada', { description: msg });
    }
  }, [incomingCall, prerollUrl]);

  const rejectIncoming = useCallback(() => {
    if (!clientRef.current) return;
    clientRef.current.rejectIncoming();
    setIncomingCall(null);
    toast.info('Chamada rejeitada');
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

  const spin = useSpinAnalysis({
    turns: transcription.turns,
    enabled: callState === 'established',
  });

  // PR4 — Acumula cada nova análise SPIN ao longo da chamada (deduplica por ref)
  useEffect(() => {
    if (spin.analysis && !analysisHistoryRef.current.includes(spin.analysis)) {
      analysisHistoryRef.current.push(spin.analysis);
      // PR-CAPTURE-A: merge customerCapture da nova análise no buffer
      if (spin.analysis.customerCapture) {
        setCustomerCaptureBuffer((prev) => mergeCustomerCapture(prev, spin.analysis!.customerCapture));
      }
    }
  }, [spin.analysis]);

  // PR4 — Mantém ref de turns sincronizado pra endCall ler sem closure issues
  useEffect(() => {
    turnsRef.current = transcription.turns;
  }, [transcription.turns]);

  // PR-CAPTURE-A: vendedor edita campo manual no sidebar
  const updateCustomerCaptureBuffer = useCallback((patch: Partial<CustomerCapture>) => {
    setCustomerCaptureBuffer((prev) => ({ ...prev, ...patch }));
  }, []);

  const dismissLastCallCapture = useCallback(() => setLastCallCapture(null), []);

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
    spinAnalysis: spin.analysis,
    spinAnalysisStatus: spin.status,
    spinAnalysisError: spin.error,
    incomingCall,
    acceptIncoming,
    rejectIncoming,
    customerCaptureBuffer,
    customerCaptureFilledCount: captureFilledCount(customerCaptureBuffer),
    lastCallCapture,
    dismissLastCallCapture,
    updateCustomerCaptureBuffer,
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
