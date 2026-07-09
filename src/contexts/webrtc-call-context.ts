import { createContext, useContext } from 'react';
import type { IncomingCallInfo } from '@/lib/sip/types';
import type { TranscriptTurn, TranscriptionStatus } from '@/lib/transcription/types';
import type { SpinAnalysis, SpinAnalysisStatus } from '@/lib/call/spin/types';
import type { ResolvedCallParty } from '@/lib/call-log/recording-policy';

/**
 * Context OBJECT + hooks do WebRTC — módulo LEVE, separado de propósito do
 * WebRTCCallContext.tsx (o Provider pesado, que importa SipClient → jssip,
 * ~250KB). Consumidores de UI (IncomingCallModal, WebRTCDialer,
 * TransferSpikePanel, AgendaTodayList, useWebRTCCall) importam DAQUI: como o
 * IncomingCallModal monta no AppShellLayout (grafo estático do entry), um
 * import do .tsx arrastava o jssip inteiro pro main bundle — medido no build
 * de 2026-06-10 — e anulava o lazy do ConditionalWebRTCProvider (o Rollup não
 * splitta módulo alcançável estaticamente). Os imports acima são type-only
 * (apagados na compilação) — este módulo custa ~zero bytes.
 *
 * ⛔ NÃO importe '@/contexts/WebRTCCallContext' (o .tsx) fora do
 * ConditionalWebRTCProvider (que o carrega via dynamic import) — guardrail de
 * CI em src/contexts/__tests__/webrtc-context-split.test.ts.
 */

export type WebRTCCallState =
  | 'idle' | 'connecting' | 'calling_origin' | 'calling_destination'
  | 'established' | 'finished' | 'noanswer' | 'busy' | 'failed' | 'error';

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
  /** SPIKE (flag telefoniaTransferSpike): dispara transferência da chamada ativa p/ um ramal. */
  spikeTransfer?: (extension: string, method: 'dtmf' | 'refer') => void;
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
  /** Cliente resolvido da ligação ATIVA (guardado por geração; resolução tardia descartada). */
  currentParty: ResolvedCallParty | null;
  currentCustomerUserId: string | null;
  /** Identidade do ATENDIMENTO (1 por ligação). Liga ligação ↔ N pedidos. */
  currentAtendimentoId: string | null;
  /** Direção da ligação ativa — define a origem do pedido (entrante/sainte). */
  callDirection: 'inbound' | 'outbound' | null;
}

export const WebRTCCallContext = createContext<WebRTCCallContextValue | null>(null);

export function useWebRTCCallContext(): WebRTCCallContextValue {
  const ctx = useContext(WebRTCCallContext);
  if (!ctx) {
    throw new Error('useWebRTCCallContext must be used within a WebRTCCallProvider');
  }
  return ctx;
}

/** Safe variant — retorna null se não houver Provider (ex: customer, ou enquanto
 *  o ConditionalWebRTCProvider ainda está carregando via Suspense). */
export function useWebRTCCallContextOptional(): WebRTCCallContextValue | null {
  return useContext(WebRTCCallContext);
}
