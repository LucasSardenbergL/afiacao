/**
 * A ligação que o CLIENTE encerra também vira farmer_calls.
 *
 * Antes só o botão "Encerrar" (endCall) persistia a sessão; o fim pelo lado remoto (BYE do cliente,
 * queda) passava pelo efeito terminal, que fechava só o call_log — a ligação gravada, transcrita e
 * atendida sumia do histórico comercial e o cliente seguia "nunca contatado". Arquivo próprio porque
 * precisa do supabase client simulado (o WebRTCCallContext.test.tsx roda com o real).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';

const { sipClientMock, invokeMock, insertMock, transcricao } = vi.hoisted(() => ({
  sipClientMock: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    makeCall: vi.fn(),
    hangUp: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getState: vi.fn(() => 'idle'),
    getCallDurationSeconds: vi.fn(() => 42),
    mute: vi.fn(),
    unmute: vi.fn(),
    isMuted: vi.fn(() => false),
    acceptIncoming: vi.fn(),
  },
  invokeMock: vi.fn(),
  insertMock: vi.fn(),
  transcricao: { turns: [] as unknown[] },
}));

vi.mock('@/lib/sip/sip-client', () => ({
  SipClient: vi.fn().mockImplementation(() => sipClientMock),
}));
vi.mock('@/lib/invoke-function', () => ({ invokeFunction: invokeMock }));
vi.mock('@/hooks/useTranscription', () => ({
  useTranscription: () => ({ status: 'idle' as const, turns: transcricao.turns, error: null }),
}));
vi.mock('@/lib/call/spin/useSpinAnalysis', () => ({
  useSpinAnalysis: () => ({ status: 'idle' as const, analysis: null, error: null }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/call-log/recording-policy', () => ({
  resolveCallParty: vi.fn(async (raw: string) => ({
    kind: 'cliente' as const,
    customerUserId: 'cust-1',
    matchConfidence: 'last8' as const,
    phoneNormalized: raw.replace(/\D/g, ''),
  })),
  shouldAutoRecord: () => true,
}));
vi.mock('@/lib/call-log/record', () => ({
  logCallStart: vi.fn(async () => {}),
  logAnswered: vi.fn(async () => {}),
  logClosed: vi.fn(async () => {}),
  enrichCallLog: vi.fn(async () => {}),
  markRecorded: vi.fn(async () => {}),
}));
vi.mock('@/lib/call-session/resolve-customer', () => ({
  resolveCustomerByPhone: vi.fn(async (raw: string) => ({
    customerUserId: 'cust-1',
    phoneDialed: raw.replace(/\D/g, ''),
    reconhecido: true,
    candidatos: 1,
  })),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'vendedora-1' } } })) },
    from: vi.fn((tabela: string) => {
      if (tabela !== 'farmer_calls') throw new Error(`tabela inesperada no teste: ${tabela}`);
      return {
        insert: (payload: unknown) => {
          insertMock(payload);
          return { select: () => ({ single: async () => ({ data: { id: 'call-1' }, error: null }) }) };
        },
      };
    }),
    functions: { invoke: vi.fn(async () => ({ data: null, error: null })) },
  },
}));

import { toast } from 'sonner';
import { WebRTCCallProvider } from '../WebRTCCallContext';
import { useWebRTCCallContext } from '../webrtc-call-context';
import { SipClient } from '@/lib/sip/sip-client';
import type { IncomingCallInfo } from '@/lib/sip/types';

const wrapper = ({ children }: { children: ReactNode }) => <WebRTCCallProvider>{children}</WebRTCCallProvider>;

const turnoFinal = {
  id: 't1', speaker: 'cliente' as const, text: 'pode mandar o orçamento', isFinal: true,
  startedAt: 1, endedAt: 2,
};

function handler(evento: string) {
  const h = sipClientMock.on.mock.calls.find((c) => c[0] === evento)?.[1];
  expect(h, `handler '${evento}' deveria estar registrado`).toBeDefined();
  return h as (...args: unknown[]) => unknown;
}

/** Turnos que a transcrição entrega DEPOIS de conectar (o hook real zera ao conectar e cresce). */
let conteudoDaLigacao: unknown[] = [];

/** Liga (inbound atendido = sempre grava), conecta, entrega a transcrição e devolve o hook. */
async function ligacaoAtendida() {
  const { result, rerender } = renderHook(() => useWebRTCCallContext(), { wrapper });
  await waitFor(() => expect(SipClient).toHaveBeenCalledTimes(1));
  await act(async () => {
    await handler('incomingCall')({ phone: '37977776666', sipCallId: 'sip-1' } as IncomingCallInfo);
  });
  await waitFor(() => expect(result.current.incomingCall?.sipCallId).toBe('sip-1'));
  await act(async () => {
    await result.current.acceptIncoming();
  });
  act(() => handler('stateChange')('established'));
  act(() => {
    transcricao.turns = [...conteudoDaLigacao];   // array NOVO, como o setTurns do hook real
    rerender();
  });
  return { result, rerender };
}

beforeEach(() => {
  vi.clearAllMocks();
  invokeMock.mockResolvedValue({ wsUri: 'wss://x', sipDomain: 'd', username: 'u', password: 'p' });
  transcricao.turns = [];
  conteudoDaLigacao = [turnoFinal];
  const fakeMic = { getTracks: () => [{ kind: 'audio', stop: vi.fn() }] } as unknown as MediaStream;
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(async () => fakeMic) },
    configurable: true,
  });
});

describe('fim da ligação pelo lado remoto', () => {
  it('o cliente desliga: a sessão gravada vira farmer_calls (uma vez)', async () => {
    await ligacaoAtendida();
    act(() => handler('stateChange')('ended'));

    await waitFor(() => expect(insertMock).toHaveBeenCalledTimes(1));
    const payload = insertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.farmer_id).toBe('vendedora-1');
    expect(payload.customer_user_id).toBe('cust-1');
  });

  it('"Encerrar" + o stateChange terminal que o hangUp dispara: persiste UMA vez, não duas', async () => {
    const { result } = await ligacaoAtendida();
    await act(async () => {
      await result.current.endCall();
    });
    act(() => handler('stateChange')('ended'));

    await waitFor(() => expect(insertMock).toHaveBeenCalledTimes(1));
    // dá ao efeito terminal a chance de (indevidamente) persistir de novo
    await act(async () => { await Promise.resolve(); });
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it('fim remoto sem transcrição nem análise: nada a persistir (regra do endCall mantida)', async () => {
    conteudoDaLigacao = [];
    await ligacaoAtendida();
    act(() => handler('stateChange')('ended'));

    await act(async () => { await Promise.resolve(); });
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('revisão adversária (2026-10-10): a sessão não herda nem cede conteúdo', () => {
  it('ligação seguinte que NÃO conecta não persiste a conversa da anterior (c1)', async () => {
    const { result, rerender } = await ligacaoAtendida();
    act(() => handler('stateChange')('ended'));
    await waitFor(() => expect(insertMock).toHaveBeenCalledTimes(1));

    // B: entra, é atendida, mas cai antes de conectar. O hook de transcrição ainda guarda os turns de
    // A (só os zera ao conectar) — persistir aqui gravaria a conversa de A no cliente de B.
    await act(async () => {
      await handler('incomingCall')({ phone: '37911112222', sipCallId: 'sip-2' } as IncomingCallInfo);
    });
    await waitFor(() => expect(result.current.incomingCall?.sipCallId).toBe('sip-2'));
    await act(async () => {
      await result.current.acceptIncoming();
    });
    // pior caso: os turns velhos de A são reemitidos antes de B conectar — só a trava `estabelecida` segura
    act(() => {
      transcricao.turns = [turnoFinal];
      rerender();
    });
    act(() => handler('stateChange')('failed'));

    await act(async () => { await Promise.resolve(); });
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it('último turno e BYE no MESMO commit: o turno entra no registro (c3)', async () => {
    conteudoDaLigacao = [];
    await ligacaoAtendida();
    act(() => {
      transcricao.turns = [turnoFinal];          // a transcrição entrega o turno...
      handler('stateChange')('ended');           // ...e o cliente desliga no mesmo lote
    });

    await waitFor(() => expect(insertMock).toHaveBeenCalledTimes(1));
    const payload = insertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(payload)).toContain('pode mandar o orçamento');
  });

  it('com uma ligação em curso, "Ligar" de novo é recusado em vez de sobrescrever a sessão (c2)', async () => {
    const { result } = await ligacaoAtendida();
    await act(async () => {
      await result.current.makeCall('37933334444');
    });
    expect(sipClientMock.makeCall).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Encerre a ligação atual antes de iniciar outra.');
  });
});
