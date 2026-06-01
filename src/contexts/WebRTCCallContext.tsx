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
import type { SpinAnalysis, SpinAnalysisStatus } from '@/lib/spin/types';
import { resolveCustomerByPhone } from '@/lib/call-session/resolve-customer';
import { buildSessionPayload } from '@/lib/call-session/build-session-payload';
import { resolveCallParty, shouldAutoRecord } from '@/lib/call-log/recording-policy';
import { logCallStart, logAnswered, logClosed, enrichCallLog, markRecorded } from '@/lib/call-log/record';

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
  makeCall: (phoneNumber: string, opts?: { forceRecord?: boolean }) => Promise<void>;
  endCall: () => Promise<void>;
  /** Ownership de UI: id do <WebRTCDialer> que iniciou a chamada atual (via claimCall).
   *  Em telas com VÁRIOS dialers (listas), só o dono reflete o estado ativo — os
   *  demais ficam idle. Sem isso, todos mostrariam o card e disparariam onCallEnd
   *  (a sessão WebRTC é única/global), registrando a chamada na linha errada. */
  callOwnerId: string | null;
  claimCall: (ownerId: string) => void;
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
  // Ownership de UI: qual <WebRTCDialer> iniciou a chamada atual (ver type).
  const [callOwnerId, setCallOwnerId] = useState<string | null>(null);
  // PR-INBOUND-CALLS
  const [incomingCall, setIncomingCall] = useState<IncomingCallInfo | null>(null);

  const clientRef = useRef<SipClient | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const callerIdRef = useRef<string | null>(null);
  const rawMicRef = useRef<MediaStream | null>(null);
  const prerollCloseRef = useRef<(() => void) | null>(null);
  const prerollPlayRef = useRef<(() => void) | null>(null);
  const prerollDurationRef = useRef<number | null>(null);
  const prerollFinishTimerRef = useRef<number | null>(null);
  // Default pro MP3 servido em public/ — o aviso LGPD NÃO pode depender de uma env
  // estar setada no build (não estava em produção → o pre-roll era pulado e a gravação
  // saía sem aviso). A env fica como override opcional (CDN/arquivo custom).
  const prerollUrl =
    (import.meta.env.VITE_NVOIP_SIP_PREROLL_URL as string | undefined) ||
    '/preroll/aviso-gravacao-lgpd.mp3';

  // PR4 — Refs pra persistência da sessão de chamada
  const analysisHistoryRef = useRef<SpinAnalysis[]>([]);
  const dialedPhoneRef = useRef<string>('');
  const callStartedAtRef = useRef<Date | null>(null);
  // Telefonia — call_log do outbound + gate de gravação
  const dialedSipCallIdRef = useRef<string | null>(null);
  const recordingRef = useRef<boolean>(false);
  // userId capturado no init — evita await de getUser no caminho quente do inbound
  // (reduz a janela em que um incomingClosed rápido correria na frente do insert).
  const currentUserIdRef = useRef<string | null>(null);
  // Ref atualizado por effect pra evitar problema de hoisting com transcription
  // (transcription é declarado depois dos useCallbacks)
  const turnsRef = useRef<TranscriptTurn[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const creds = await invokeFunction<{
          wsUri: string; sipDomain: string; username: string; password: string; callerId?: string | null;
        }>('nvoip-sip-creds', {});
        if (cancelled) return;

        callerIdRef.current = creds.callerId ?? null;
        const { data: { user: initUser } } = await supabase.auth.getUser();
        if (cancelled) return;
        currentUserIdRef.current = initUser?.id ?? null;
        const client = new SipClient(creds);
        clientRef.current = client;

        client.on('stateChange', (s) => setCallState(SIP_TO_PUBLIC[s]));
        client.on('localStream', (s) => setLocalStream(s));
        client.on('remoteStream', (s) => setRemoteStream(s));
        // PR-INBOUND-CALLS: emite quando chamada entra
        client.on('incomingCall', async (info) => {
          setIncomingCall(info);
          const uid = currentUserIdRef.current;
          if (!uid) return;
          // Insere ASAP (sem BINA) pra um incomingClosed rápido achar a linha.
          await logCallStart({
            farmerId: uid,
            direction: 'inbound',
            provider: 'nvoip_sip',
            phoneRaw: info.phone,
            party: { kind: 'desconhecido', customerUserId: null, matchConfidence: 'none', phoneNormalized: normalizeBrPhone(info.phone) },
            recorded: false,
            sipCallId: info.sipCallId,
          });
          // Enriquece com BINA (query mais lenta) — não bloqueia o ring.
          const party = await resolveCallParty(info.phone);
          if (party.customerUserId) {
            await enrichCallLog(info.sipCallId, party, shouldAutoRecord(party.kind));
          }
        });
        // PR-INBOUND-CALLS: fecha a linha do call_log (atendida/perdida)
        client.on('incomingClosed', async ({ sipCallId, answered, durationSeconds }) => {
          await logClosed(sipCallId, { answered, durationSeconds });
        });
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
      // Telefonia — marca a linha outbound como 'answered' assim que conecta. Sem isso a
      // linha fica 'ringing' a chamada inteira e o cron backstop (90s) marca uma chamada
      // VIVA como 'failed'. logAnswered é idempotente (WHERE status='ringing') e o cron só
      // toca em 'ringing' → não falha chamada ativa. O fechamento terminal ainda seta 'ended'.
      if (dialedSipCallIdRef.current) void logAnswered(dialedSipCallIdRef.current);
    } else if (callState !== 'established' && durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
  }, [callState]);

  // Telefonia — fecha o call_log do outbound quando a chamada termina por QUALQUER via
  // (no-answer, busy, failed, error ou remote hangup), não só pelo botão "Encerrar" (endCall).
  // Sem isso, linhas outbound ficavam presas em 'ringing' pra sempre (o cron backstop só varria inbound).
  // Não duplica vs endCall: endCall já zera dialedSipCallIdRef.current antes do hangUp(), então
  // quando o hangUp dispara o stateChange terminal o guard abaixo vira no-op. E logClosed é
  // idempotente (.neq('status','ended')). Inbound não passa por aqui (dialedSipCallIdRef fica null).
  useEffect(() => {
    const TERMINAL: WebRTCCallState[] = ['finished', 'noanswer', 'busy', 'failed', 'error'];
    if (TERMINAL.includes(callState) && dialedSipCallIdRef.current) {
      const sid = dialedSipCallIdRef.current;
      dialedSipCallIdRef.current = null;
      const durationSeconds = clientRef.current?.getCallDurationSeconds() ?? 0;
      const answered = durationSeconds > 0;
      if (answered) void logAnswered(sid);
      void logClosed(sid, { answered, durationSeconds });
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

  const makeCall = useCallback(async (phoneNumber: string, opts?: { forceRecord?: boolean }) => {
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

    // Telefonia — resolve quem é o número e decide se grava (cliente/fornecedor → auto;
    // ou forceRecord pelo caller). recordingRef guia preroll/transcrição/persist abaixo.
    const { data: { user } } = await supabase.auth.getUser();
    const party = await resolveCallParty(phoneNumber);
    const record = (opts?.forceRecord ?? false) || shouldAutoRecord(party.kind);
    recordingRef.current = record;
    const sipCallId = crypto.randomUUID();
    dialedSipCallIdRef.current = sipCallId;
    if (user) {
      await logCallStart({
        farmerId: user.id,
        direction: 'outbound',
        provider: 'nvoip_sip',
        phoneRaw: phoneNumber,
        party,
        recorded: record,
        sipCallId,
        callerIdUsed: callerIdRef.current,
      });
    }

    // PR4 — Reset refs de sessão antes de iniciar nova chamada
    analysisHistoryRef.current = [];
    dialedPhoneRef.current = normalized;
    callStartedAtRef.current = new Date();

    cleanupAudioResources();

    try {
      const rawMic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      rawMicRef.current = rawMic;

      let streamForCall: MediaStream = rawMic;
      if (record) {
        // Gravação ON: expõe vendorMicStream (liga transcrição) + mixa preroll LGPD.
        setVendorMicStream(rawMic);
        if (prerollUrl) {
          const mix = await mixPrerollWithMic(prerollUrl, rawMic);
          streamForCall = mix.stream;
          // play() é disparado pelo useEffect ao detectar callState === 'established'
          prerollPlayRef.current = mix.play;
          prerollCloseRef.current = mix.close;
          prerollDurationRef.current = mix.durationSeconds;
        }
      }
      // Gravação OFF (número avulso/desconhecido sem forceRecord): liga direto com o
      // mic cru — sem preroll, sem transcrição (vendorMicStream fica null → useTranscription
      // não inicia), sem prerollPlaying. Áudio bidirecional segue funcionando.

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
    const wasRecording = recordingRef.current;

    // Telefonia — duração/answered vêm do SipClient (callStartedAt só existe após accept).
    // Captura ANTES de hangUp (hangUp não zera callStartedAt, mas captura é mais seguro).
    const durationSeconds = clientRef.current?.getCallDurationSeconds() ?? 0;
    const answered = durationSeconds > 0;

    clientRef.current?.hangUp();
    cleanupAudioResources();
    setIsMuted(false);
    toast.success('Chamada encerrada');

    // call_log: fecha a linha do outbound (answered → ended; senão → missed).
    if (dialedSipCallIdRef.current) {
      if (answered) void logAnswered(dialedSipCallIdRef.current);
      void logClosed(dialedSipCallIdRef.current, { answered, durationSeconds });
      dialedSipCallIdRef.current = null;
    }

    // Fire-and-forget — não bloqueia UI. Só persiste farmer_calls quando GRAVAMOS
    // (cliente/fornecedor ou forceRecord) E houve conteúdo útil.
    if (wasRecording && startedAt && (turnsSnapshot.length > 0 || analysesSnapshot.length > 0)) {
      void persistCallSession({
        startedAt,
        endedAt: new Date(),
        turns: turnsSnapshot,
        analyses: analysesSnapshot,
        dialedPhone,
      });
    }
  }, []);

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
    // Inbound atendido sempre grava (preroll + transcrição inalterados) → persist habilitado.
    // dialedSipCallIdRef fica null: o fechamento da call_log do inbound é feito pelo
    // listener 'incomingClosed' (SipClient), não pelo endCall.
    recordingRef.current = true;
    dialedSipCallIdRef.current = null;

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
      // call_log: marca answered (idempotente — só atualiza se ainda 'ringing')
      if (incomingCall.sipCallId) {
        await logAnswered(incomingCall.sipCallId);
        // Inbound atendido sempre grava (toca a Sara) → reflete no ledger.
        void markRecorded(incomingCall.sipCallId);
      }
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
    // call_log: fecha como rejected ANTES de limpar o incomingCall (precisa do sipCallId)
    if (incomingCall?.sipCallId) {
      void logClosed(incomingCall.sipCallId, { answered: false, rejected: true, durationSeconds: 0 });
    }
    clientRef.current.rejectIncoming();
    setIncomingCall(null);
    toast.info('Chamada rejeitada');
  }, [incomingCall]);

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
    }
  }, [spin.analysis]);

  // PR4 — Mantém ref de turns sincronizado pra endCall ler sem closure issues
  useEffect(() => {
    turnsRef.current = transcription.turns;
  }, [transcription.turns]);

  // Ownership: o <WebRTCDialer> que vai discar se declara dono ANTES do makeCall.
  const claimCall = useCallback((ownerId: string) => setCallOwnerId(ownerId), []);

  // Libera o dono quando a chamada volta a idle (a próxima chamada re-reivindica).
  useEffect(() => {
    if (callState === 'idle') setCallOwnerId(null);
  }, [callState]);

  const value: WebRTCCallContextValue = {
    callState,
    callId: null,
    callDuration,
    audioLink: null,
    makeCall,
    endCall,
    callOwnerId,
    claimCall,
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

// Safe variant — retorna null se não houver Provider (ex: customer, ou enquanto
// o ConditionalWebRTCProvider ainda está carregando via Suspense).
// eslint-disable-next-line react-refresh/only-export-components
export function useWebRTCCallContextOptional(): WebRTCCallContextValue | null {
  return useContext(WebRTCCallContext);
}
