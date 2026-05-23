import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
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

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
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

import { WebRTCCallProvider, useWebRTCCallContext } from '../WebRTCCallContext';
import { SipClient } from '@/lib/sip/sip-client';

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
});
