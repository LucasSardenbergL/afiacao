import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expectRenderToThrow } from '@/test/render-throws';

const { sipClientMock, invokeMock } = vi.hoisted(() => ({
  sipClientMock: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    makeCall: vi.fn(),
    hangUp: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getState: vi.fn(() => 'idle'),
    getCallDurationSeconds: vi.fn(() => 0),
    mute: vi.fn(),
    unmute: vi.fn(),
    isMuted: vi.fn(() => false),
  },
  invokeMock: vi.fn(),
}));

vi.mock('@/lib/sip/sip-client', () => ({
  SipClient: vi.fn().mockImplementation(() => sipClientMock),
}));

vi.mock('@/lib/invoke-function', () => ({
  invokeFunction: invokeMock,
}));

vi.mock('@/hooks/useTranscription', () => ({
  useTranscription: () => ({
    status: 'idle' as const,
    turns: [],
    error: null,
  }),
}));

vi.mock('@/hooks/useSpinAnalysis', () => ({
  useSpinAnalysis: () => ({
    status: 'idle' as const,
    analysis: null,
    error: null,
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/call-log/recording-policy', () => ({
  resolveCallParty: vi.fn(async (raw: string) => ({
    kind: 'desconhecido' as const,
    customerUserId: null,
    matchConfidence: 'none' as const,
    phoneNormalized: raw.replace(/\D/g, ''),
  })),
  shouldAutoRecord: () => false,
}));

vi.mock('@/lib/call-log/record', () => ({
  logCallStart: vi.fn(async () => {}),
  logAnswered: vi.fn(async () => {}),
  logClosed: vi.fn(async () => {}),
  enrichCallLog: vi.fn(async () => {}),
  markRecorded: vi.fn(async () => {}),
}));

import { WebRTCCallProvider } from '../WebRTCCallContext';
import { useWebRTCCallContext } from '../webrtc-call-context';
import { SipClient } from '@/lib/sip/sip-client';
import { resolveCallParty } from '@/lib/call-log/recording-policy';
import type { IncomingCallInfo } from '@/lib/sip/types';

const wrapper = ({ children }: { children: ReactNode }) => (
  <WebRTCCallProvider>{children}</WebRTCCallProvider>
);

const fakeCreds = {
  wsUri: 'wss://app.nvoip.com.br:7443',
  sipDomain: '54.233.253.44',
  username: '137973001',
  password: 'pw',
};

beforeEach(() => {
  vi.clearAllMocks();
  invokeMock.mockResolvedValue(fakeCreds);
});

describe('WebRTCCallProvider', () => {
  it('instancia SipClient uma única vez ao montar', async () => {
    renderHook(() => useWebRTCCallContext(), { wrapper });
    await waitFor(() => expect(SipClient).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith('nvoip-sip-creds', expect.anything());
  });

  it('múltiplos consumers sob o MESMO Provider compartilham SipClient e state', async () => {
    const { result } = renderHook(
      () => ({
        a: useWebRTCCallContext(),
        b: useWebRTCCallContext(),
      }),
      { wrapper }
    );

    await waitFor(() => expect(SipClient).toHaveBeenCalledTimes(1));

    // Same Provider value → same function references → same SipClient instance
    expect(result.current.a.makeCall).toBe(result.current.b.makeCall);
    expect(result.current.a.endCall).toBe(result.current.b.endCall);
    expect(result.current.a.callState).toBe(result.current.b.callState);
  });

  it('useWebRTCCallContext lança erro quando usado fora do Provider', () => {
    const Probe = () => {
      useWebRTCCallContext();
      return null;
    };
    expectRenderToThrow(<Probe />, /must be used within.*WebRTCCallProvider/i);
  });

  it('expõe isMuted e toggleMute (inicialmente unmuted)', async () => {
    const { result } = renderHook(() => useWebRTCCallContext(), { wrapper });
    await waitFor(() => expect(SipClient).toHaveBeenCalled());

    expect(result.current.isMuted).toBe(false);
    expect(typeof result.current.toggleMute).toBe('function');
  });

  it('expõe prerollPlaying e prerollEndsAt (inicialmente off)', async () => {
    const { result } = renderHook(() => useWebRTCCallContext(), { wrapper });
    await waitFor(() => expect(SipClient).toHaveBeenCalled());

    expect(result.current.prerollPlaying).toBe(false);
    expect(result.current.prerollEndsAt).toBeNull();
  });

  it('expõe campos de transcrição (inicialmente idle/empty)', async () => {
    const { result } = renderHook(() => useWebRTCCallContext(), { wrapper });
    await waitFor(() => expect(SipClient).toHaveBeenCalled());

    expect(result.current.transcriptionStatus).toBe('idle');
    expect(result.current.transcriptionTurns).toEqual([]);
    expect(result.current.transcriptionError).toBeNull();
    expect(result.current.vendorMicStream).toBeNull();
  });

  it('expõe campos de SPIN analysis (inicialmente idle/null)', async () => {
    const { result } = renderHook(() => useWebRTCCallContext(), { wrapper });
    await waitFor(() => expect(SipClient).toHaveBeenCalled());

    expect(result.current.spinAnalysisStatus).toBe('idle');
    expect(result.current.spinAnalysis).toBeNull();
    expect(result.current.spinAnalysisError).toBeNull();
  });

  // Incidente 2026-06-09 (LGPD): após hangup REMOTO o rawMic ficava capturado
  // (red dot aceso, cliente seguia ouvindo a vendedora) até a próxima ação.
  // Estado terminal deve liberar os recursos de áudio imediatamente.
  it('estado terminal libera o microfone (rawMic) após fim remoto da chamada', async () => {
    const stopMock = vi.fn();
    const fakeMic = { getTracks: () => [{ kind: 'audio', stop: stopMock }] } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => fakeMic) },
      configurable: true,
    });

    const { result } = renderHook(() => useWebRTCCallContext(), { wrapper });
    await waitFor(() => expect(SipClient).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.makeCall('37999998888');
    });
    expect(sipClientMock.makeCall).toHaveBeenCalled();
    expect(stopMock).not.toHaveBeenCalled();

    const stateHandler = sipClientMock.on.mock.calls.find((c) => c[0] === 'stateChange')?.[1];
    expect(stateHandler).toBeDefined();
    act(() => stateHandler('established'));
    // Cliente desligou (BYE remoto) — nenhum clique em "Encerrar" acontece
    act(() => stateHandler('ended'));

    await waitFor(() => expect(stopMock).toHaveBeenCalled());
  });
});

const UUID_RE = /^[0-9a-f-]{36}$/;

/**
 * Fase 1 — contexto da ligação ATIVA exposto pro HUD: cliente resolvido (party),
 * id de atendimento (1 por ligação) e direção (inbound/outbound). Reusa o mock
 * hoisted `sipClientMock` + o mock de `resolveCallParty` (controlado por teste).
 */
describe('currentParty / atendimento / direção (Fase 1)', () => {
  beforeEach(() => {
    // mic fake p/ os caminhos de áudio do makeCall/acceptIncoming não quebrarem
    const fakeMic = { getTracks: () => [{ kind: 'audio', stop: vi.fn() }] } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => fakeMic) },
      configurable: true,
    });
    // default volta pro 'desconhecido' (o vi.clearAllMocks do beforeEach global
    // só zera as chamadas; a implementação do mock persiste, mas re-afirmo aqui).
    vi.mocked(resolveCallParty).mockImplementation(async (raw: string) => ({
      kind: 'desconhecido' as const,
      customerUserId: null,
      matchConfidence: 'none' as const,
      phoneNormalized: raw.replace(/\D/g, ''),
    }));
  });

  function getHandler(event: string) {
    const handler = sipClientMock.on.mock.calls.find((c) => c[0] === event)?.[1];
    expect(handler, `handler '${event}' deveria estar registrado`).toBeDefined();
    return handler as (...args: unknown[]) => unknown;
  }

  it('makeCall com cliente preenche party/atendimento/direção (outbound)', async () => {
    vi.mocked(resolveCallParty).mockResolvedValue({
      kind: 'cliente',
      customerUserId: 'cust-1',
      matchConfidence: 'last8',
      phoneNormalized: '37999998888',
    });

    const { result } = renderHook(() => useWebRTCCallContext(), { wrapper });
    await waitFor(() => expect(SipClient).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.makeCall('37999998888');
    });

    await waitFor(() => expect(result.current.currentParty?.kind).toBe('cliente'));
    expect(result.current.currentCustomerUserId).toBe('cust-1');
    expect(result.current.currentAtendimentoId).toMatch(UUID_RE);
    expect(result.current.callDirection).toBe('outbound');
  });

  it('makeCall com telefone inválido NÃO cunha atendimento/direção', async () => {
    const { result } = renderHook(() => useWebRTCCallContext(), { wrapper });
    await waitFor(() => expect(SipClient).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.makeCall('123');
    });

    expect(sipClientMock.makeCall).not.toHaveBeenCalled();
    expect(result.current.currentAtendimentoId).toBeNull();
    expect(result.current.callDirection).toBeNull();
    expect(result.current.currentParty).toBeNull();
  });

  it('start-mutex: makeCall concorrente não disca 2× (B é rejeitado)', async () => {
    vi.mocked(resolveCallParty).mockResolvedValue({
      kind: 'cliente',
      customerUserId: 'cust-1',
      matchConfidence: 'last8',
      phoneNormalized: '37999998888',
    });

    const { result } = renderHook(() => useWebRTCCallContext(), { wrapper });
    await waitFor(() => expect(SipClient).toHaveBeenCalledTimes(1));

    await act(async () => {
      // A em voo (não await) + B SÍNCRONO logo em seguida → o mutex já está preso
      // (setado de forma síncrona no topo do makeCall, antes de qualquer await) →
      // B sai sem discar. Sem boundary de microtask entre A e B, A não termina no meio.
      const callA = result.current.makeCall('37999998888');
      const callB = result.current.makeCall('37988887777');
      await Promise.all([callA, callB]);
    });

    expect(sipClientMock.makeCall).toHaveBeenCalledTimes(1);
    expect(sipClientMock.makeCall).toHaveBeenCalledWith('37999998888', expect.anything());
  });

  it('inbound: accept ANTES do lookup do ring resolver reflete o cliente (re-resolve, inbound)', async () => {
    const { result } = renderHook(() => useWebRTCCallContext(), { wrapper });
    await waitFor(() => expect(SipClient).toHaveBeenCalledTimes(1));

    const info: IncomingCallInfo = {
      phone: '37977776666',
      sipCallId: 'sip-1',
    } as IncomingCallInfo;

    // O lookup do ring (resolveCallParty no listener) fica PENDENTE: simula accept
    // antes do ring resolver. acceptIncoming re-resolve (com a impl abaixo, que
    // devolve o cliente).
    vi.mocked(resolveCallParty).mockResolvedValue({
      kind: 'cliente',
      customerUserId: 'cust-inbound',
      matchConfidence: 'last8',
      phoneNormalized: '37977776666',
    });

    const incomingHandler = getHandler('incomingCall');
    await act(async () => {
      await incomingHandler(info);
    });
    await waitFor(() => expect(result.current.incomingCall?.sipCallId).toBe('sip-1'));

    await act(async () => {
      await result.current.acceptIncoming();
    });

    await waitFor(() => expect(result.current.currentCustomerUserId).toBe('cust-inbound'));
    expect(result.current.callDirection).toBe('inbound');
    expect(result.current.currentAtendimentoId).toMatch(UUID_RE);
  });

  it('estado terminal zera party/atendimento/direção', async () => {
    vi.mocked(resolveCallParty).mockResolvedValue({
      kind: 'cliente',
      customerUserId: 'cust-1',
      matchConfidence: 'last8',
      phoneNormalized: '37999998888',
    });

    const { result } = renderHook(() => useWebRTCCallContext(), { wrapper });
    await waitFor(() => expect(SipClient).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.makeCall('37999998888');
    });
    await waitFor(() => expect(result.current.currentAtendimentoId).toMatch(UUID_RE));

    const stateHandler = getHandler('stateChange');
    act(() => stateHandler('ended'));

    await waitFor(() => expect(result.current.currentParty).toBeNull());
    expect(result.current.currentCustomerUserId).toBeNull();
    expect(result.current.currentAtendimentoId).toBeNull();
    expect(result.current.callDirection).toBeNull();
  });
});
