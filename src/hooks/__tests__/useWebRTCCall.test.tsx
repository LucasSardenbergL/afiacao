import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock setup MUST be hoisted (vi.mock is hoisted above other code)
const { sipClientMock, mixMock, invokeMock, getUserMediaMock } = vi.hoisted(() => {
  return {
    sipClientMock: {
      connect: vi.fn(),
      disconnect: vi.fn(),
      makeCall: vi.fn(),
      hangUp: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      getState: vi.fn(() => 'idle'),
      getCallDurationSeconds: vi.fn(() => 0),
    },
    mixMock: vi.fn(),
    invokeMock: vi.fn(),
    getUserMediaMock: vi.fn(),
  };
});

vi.mock('@/lib/sip/sip-client', () => ({
  SipClient: vi.fn().mockImplementation(() => sipClientMock),
}));

vi.mock('@/lib/sip/audio-preroll', () => ({
  mixPrerollWithMic: mixMock,
}));

vi.mock('@/lib/invoke-function', () => ({
  invokeFunction: invokeMock,
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { useWebRTCCall } from '../useWebRTCCall';

const fakeCreds = {
  wsUri: 'wss://sip.nvoip.com.br:7443/ws',
  sipDomain: 'sip.nvoip.com.br',
  username: '1234567',
  password: 'pw',
};

beforeEach(() => {
  vi.clearAllMocks();
  invokeMock.mockResolvedValue(fakeCreds);
  // Default: getUserMedia returns a stream with a stoppable track
  getUserMediaMock.mockResolvedValue({
    getTracks: () => [{ stop: vi.fn(), kind: 'audio' }],
    getAudioTracks: () => [{ stop: vi.fn(), kind: 'audio' }],
  });
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: { getUserMedia: getUserMediaMock },
    configurable: true,
    writable: true,
  });
});

describe('useWebRTCCall', () => {
  it('inicializa SipClient e chama connect após carregar credenciais', async () => {
    const { result } = renderHook(() => useWebRTCCall());
    await waitFor(() => expect(sipClientMock.connect).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledWith('nvoip-sip-creds', expect.anything());
    expect(result.current.callState).toBe('idle');
  });

  it('makeCall pede mic e chama SipClient.makeCall sem preroll quando URL ausente', async () => {
    const { result } = renderHook(() => useWebRTCCall());
    await waitFor(() => expect(sipClientMock.connect).toHaveBeenCalled());

    await act(async () => {
      await result.current.makeCall('37999998888');
    });

    expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true, video: false });
    expect(mixMock).not.toHaveBeenCalled();
    expect(sipClientMock.makeCall).toHaveBeenCalledWith('37999998888', expect.anything());
  });

  it('makeCall usa preroll quando VITE_NVOIP_SIP_PREROLL_URL definida', async () => {
    // Simula env var via vi.stubEnv
    vi.stubEnv('VITE_NVOIP_SIP_PREROLL_URL', '/preroll/aviso.mp3');
    const mixedStream = { getTracks: () => [] };
    const closeMix = vi.fn();
    mixMock.mockResolvedValue({ stream: mixedStream, close: closeMix });

    const { result } = renderHook(() => useWebRTCCall());
    await waitFor(() => expect(sipClientMock.connect).toHaveBeenCalled());

    await act(async () => {
      await result.current.makeCall('37999998888');
    });

    expect(mixMock).toHaveBeenCalledWith('/preroll/aviso.mp3', expect.anything());
    expect(sipClientMock.makeCall).toHaveBeenCalledWith('37999998888', mixedStream);
    vi.unstubAllEnvs();
  });

  it('endCall chama SipClient.hangUp E para tracks do mic raw E fecha preroll', async () => {
    vi.stubEnv('VITE_NVOIP_SIP_PREROLL_URL', '/preroll/aviso.mp3');
    const stopMicTrack = vi.fn();
    getUserMediaMock.mockResolvedValue({
      getTracks: () => [{ stop: stopMicTrack, kind: 'audio' }],
      getAudioTracks: () => [{ stop: stopMicTrack, kind: 'audio' }],
    });
    const closeMix = vi.fn();
    mixMock.mockResolvedValue({ stream: { getTracks: () => [] }, close: closeMix });

    const { result } = renderHook(() => useWebRTCCall());
    await waitFor(() => expect(sipClientMock.connect).toHaveBeenCalled());

    await act(async () => {
      await result.current.makeCall('37999998888');
    });
    await act(async () => {
      await result.current.endCall();
    });

    expect(sipClientMock.hangUp).toHaveBeenCalled();
    expect(closeMix).toHaveBeenCalled();
    expect(stopMicTrack).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('makeCall com telefone inválido (<10 digitos) não chama SipClient.makeCall', async () => {
    const { result } = renderHook(() => useWebRTCCall());
    await waitFor(() => expect(sipClientMock.connect).toHaveBeenCalled());

    await act(async () => {
      await result.current.makeCall('999'); // muito curto
    });

    expect(sipClientMock.makeCall).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/inválido/i);
  });
});
