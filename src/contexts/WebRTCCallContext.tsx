import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { SipClient } from '@/lib/sip/sip-client';
import type { SipCallState, IncomingCallInfo } from '@/lib/sip/types';
import { invokeFunction } from '@/lib/invoke-function';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { normalizeBrPhone, formatBrPhone } from '@/lib/phone';
import { mixPrerollWithMic } from '@/lib/sip/audio-preroll';
import { useTranscription } from '@/hooks/useTranscription';
import type { TranscriptTurn } from '@/lib/transcription/types';
import { useSpinAnalysis } from '@/hooks/useSpinAnalysis';
import type { SpinAnalysis } from '@/lib/spin/types';
import { resolveCustomerByPhone } from '@/lib/call-session/resolve-customer';
import { buildSessionPayload } from '@/lib/call-session/build-session-payload';
import { resolveCallParty, shouldAutoRecord, type ResolvedCallParty } from '@/lib/call-log/recording-policy';
import { logCallStart, logAnswered, logClosed, enrichCallLog, markRecorded } from '@/lib/call-log/record';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
// O context OBJECT + hooks + types vivem no módulo LEVE webrtc-call-context.ts
// (sem jssip). Este .tsx é o Provider PESADO — só o ConditionalWebRTCProvider
// pode importá-lo (via dynamic import); consumidores usam o módulo leve.
// Guardrail: src/contexts/__tests__/webrtc-context-split.test.ts.
import {
  WebRTCCallContext,
  type WebRTCCallContextValue,
  type WebRTCCallState,
} from './webrtc-call-context';

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
  atendimentoId: string | null;
}): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { customerUserId, phoneDialed } = await resolveCustomerByPhone(opts.dialedPhone);

    // Reverse-link best-effort: grava atendimento_id em farmer_calls quando disponível.
    // O link primário confiável é sales_orders.atendimento_id — este é auxiliar (só existe
    // quando endCall tem conteúdo gravável; remote-hangup/sem-transcrição não geram linha).
    const payload = buildSessionPayload({
      farmerId: user.id,
      customerUserId,
      phoneDialed,
      callBackend: 'webrtc',
      startedAt: opts.startedAt,
      endedAt: opts.endedAt,
      turns: opts.turns,
      analyses: opts.analyses,
      atendimentoId: opts.atendimentoId,
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
  // Onda 1 / Fase 1 — contexto da ligação ATIVA exposto pro HUD global.
  const [currentParty, setCurrentParty] = useState<ResolvedCallParty | null>(null);
  const [currentAtendimentoId, setCurrentAtendimentoId] = useState<string | null>(null);
  const [callDirection, setCallDirection] = useState<'inbound' | 'outbound' | null>(null);

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
  // Onda 1 / Fase 1 — guards do contexto da ligação:
  const callGenerationRef = useRef(0);                          // guard de async-race (resolução tardia de party descartada)
  const startingCallRef = useRef(false);                        // start-mutex (anti-concorrência de makeCall/accept)
  const atendimentoIdRef = useRef<string | null>(null);         // snapshot do atendimento pro persist (Task 2 usa)
  const incomingPartyRef = useRef<{ sipCallId: string; party: ResolvedCallParty } | null>(null);

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
          // Guarda o party do ring por sipCallId pro acceptIncoming reusar sem
          // re-resolver (se o accept chegar depois do lookup terminar).
          incomingPartyRef.current = { sipCallId: info.sipCallId, party };
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
    if (!TERMINAL.includes(callState)) return;
    // LGPD: libera mic/preroll também quando o fim veio do lado REMOTO (BYE do
    // cliente, falha) — sem isso o rawMic ficava capturado (red dot aceso) até a
    // próxima ação do vendedor. Idempotente com o cleanup do endCall.
    cleanupAudioResources();
    // Onda 1 / Fase 1 — fim da ligação: limpa o contexto exposto pro HUD e
    // invalida qualquer resolução de party em voo (gen++). Reseta o mutex como
    // backstop (se algum caminho de saída do makeCall não chegou no finally).
    callGenerationRef.current += 1;
    startingCallRef.current = false;
    setCurrentParty(null);
    setCurrentAtendimentoId(null);
    setCallDirection(null);
    atendimentoIdRef.current = null;
    incomingPartyRef.current = null;
    if (dialedSipCallIdRef.current) {
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
    if (isLensActive()) {
      toast.error('Ligação indisponível na lente (somente leitura). Saia da lente para ligar.');
      return;
    }
    // Start-mutex: serializa makeCall concorrente (a sessão SIP é única/global).
    // Sem isso, duplo-toque/race abriria 2 INVITEs e o atendimento minted ficaria
    // inconsistente. Nota: acceptIncoming NÃO usa este mutex (atende chamada já
    // existente, não abre novo INVITE). Auto-limpo no finally em TODOS os caminhos.
    if (startingCallRef.current) {
      toast.error('Já há uma chamada sendo iniciada.');
      return;
    }
    startingCallRef.current = true;
    try {
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

      // Cunha o atendimento + direção SÓ depois das validações de telefone/clientRef
      // (telefone inválido não deve gerar atendimento). gen é capturado ANTES do
      // await de resolveCallParty → uma resolução tardia de geração antiga é descartada.
      const gen = ++callGenerationRef.current;
      const atendimentoId = crypto.randomUUID();
      atendimentoIdRef.current = atendimentoId;
      setCurrentAtendimentoId(atendimentoId);
      setCallDirection('outbound');

      // Telefonia — resolve quem é o número e decide se grava (cliente/fornecedor → auto;
      // ou forceRecord pelo caller). recordingRef guia preroll/transcrição/persist abaixo.
      const { data: { user } } = await supabase.auth.getUser();
      const party = await resolveCallParty(phoneNumber);
      if (callGenerationRef.current === gen) setCurrentParty(party);
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
    } finally {
      startingCallRef.current = false;
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
    // Onda 1 / Fase 1 — captura antes do efeito terminal zerar o ref.
    const atendimentoIdSnapshot = atendimentoIdRef.current;

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
        atendimentoId: atendimentoIdSnapshot,
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

  // SPIKE (flag telefoniaTransferSpike): dispara transferência da chamada ativa.
  // Guard de lente igual ao makeCall (mutação SIP fura o write-guard do client → gateia na fonte).
  const spikeTransfer = useCallback((extension: string, method: 'dtmf' | 'refer') => {
    if (isLensActive()) {
      toast.error('Transferência indisponível na lente (somente leitura).');
      return;
    }
    if (!clientRef.current) return;
    if (method === 'dtmf') clientRef.current.transferViaDtmf(extension);
    else clientRef.current.transferViaRefer(extension);
  }, []);

  // PR-INBOUND-CALLS: atende chamada pendente. Mesmo setup de áudio do makeCall (mic + preroll).
  const acceptIncoming = useCallback(async () => {
    if (isLensActive()) {
      toast.error('Atender chamada indisponível na lente (somente leitura).');
      return;
    }
    if (!incomingCall || !clientRef.current) return;

    // Onda 1 / Fase 1 — cunha o atendimento + direção (inbound) e resolve o party.
    const gen = ++callGenerationRef.current;
    const atendimentoId = crypto.randomUUID();
    atendimentoIdRef.current = atendimentoId;
    setCurrentAtendimentoId(atendimentoId);
    setCallDirection('inbound');
    const sipId = incomingCall.sipCallId;
    // Reusa o party já resolvido pelo ring (por sipCallId); se o ring ainda não
    // resolveu (accept rápido), re-resolve em background e guarda por geração.
    const ringParty = incomingPartyRef.current?.sipCallId === sipId ? incomingPartyRef.current.party : null;
    if (ringParty) {
      setCurrentParty(ringParty);
    } else {
      void resolveCallParty(incomingCall.phone).then((p) => {
        if (callGenerationRef.current === gen) setCurrentParty(p);
      });
    }

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
    incomingPartyRef.current = null;
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
    spikeTransfer,
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
    currentParty,
    currentCustomerUserId: currentParty?.customerUserId ?? null,
    currentAtendimentoId,
    callDirection,
  };

  return <WebRTCCallContext.Provider value={value}>{children}</WebRTCCallContext.Provider>;
}
