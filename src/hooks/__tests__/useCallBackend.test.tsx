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

vi.mock('@/hooks/useWebRTCCall', () => ({
  useWebRTCCall: () => webrtcReturn,
}));

import { useCallBackend } from '../useCallBackend';

describe('useCallBackend dispatcher', () => {
  it('usa SEMPRE o backend WebRTC (Nvoip click-to-call descontinuado da UI)', () => {
    const { result } = renderHook(() => useCallBackend());
    expect(result.current.backend).toBe('webrtc');
    expect(result.current.makeCall).toBe(webrtcReturn.makeCall);
  });
});
