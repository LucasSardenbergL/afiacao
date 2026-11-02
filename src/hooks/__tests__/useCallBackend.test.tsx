import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const webrtcReturn = {
  callState: 'idle' as const,
  callId: null,
  callDuration: 0,
  audioLink: null,
  error: null,
  isActive: false,
  isConnecting: false,
  isRinging: false,
  isEstablished: false,
  isFinished: false,
  makeCall: vi.fn(),
  endCall: vi.fn(),
  localStream: null,
  remoteStream: null,
};

const h = vi.hoisted(() => ({ semProvider: false }));

vi.mock('@/hooks/useWebRTCCall', () => ({
  useWebRTCCall: () => webrtcReturn,
  useWebRTCCallOpcional: () => (h.semProvider ? null : webrtcReturn),
}));

import { useCallBackend, useCallBackendOpcional } from '../useCallBackend';

describe('useCallBackend dispatcher', () => {
  it('usa SEMPRE o backend WebRTC (Nvoip click-to-call descontinuado da UI)', () => {
    const { result } = renderHook(() => useCallBackend());
    expect(result.current.backend).toBe('webrtc');
    expect(result.current.makeCall).toBe(webrtcReturn.makeCall);
  });
});

describe('useCallBackendOpcional (FarmerCalls)', () => {
  it('com Provider: idêntico ao useCallBackend', () => {
    h.semProvider = false;
    const { result } = renderHook(() => useCallBackendOpcional());
    expect(result.current.backend).toBe('webrtc');
    expect(result.current.makeCall).toBe(webrtcReturn.makeCall);
  });

  it('sem Provider (Telefonia congelada): não lança, backend indisponivel e inerte', () => {
    h.semProvider = true;
    const { result } = renderHook(() => useCallBackendOpcional());
    expect(result.current.backend).toBe('indisponivel');
    expect(result.current.callState).toBe('idle');
    expect(result.current.isActive).toBe(false);
  });
});
