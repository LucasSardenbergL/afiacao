import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@/hooks/useFeatureFlag', () => ({
  useFeatureFlag: vi.fn(),
}));

const nvoipReturn = {
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
};

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

vi.mock('@/hooks/useNvoipCall', () => ({
  useNvoipCall: () => nvoipReturn,
}));

vi.mock('@/hooks/useWebRTCCall', () => ({
  useWebRTCCall: () => webrtcReturn,
}));

import { useCallBackend } from '../useCallBackend';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';

describe('useCallBackend dispatcher', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retorna useNvoipCall quando flag off', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (useFeatureFlag as any).mockReturnValue([false, vi.fn()]);
    const { result } = renderHook(() => useCallBackend());
    expect(result.current.backend).toBe('nvoip');
    expect(result.current.makeCall).toBe(nvoipReturn.makeCall);
  });

  it('retorna useWebRTCCall quando flag on', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (useFeatureFlag as any).mockReturnValue([true, vi.fn()]);
    const { result } = renderHook(() => useCallBackend());
    expect(result.current.backend).toBe('webrtc');
    expect(result.current.makeCall).toBe(webrtcReturn.makeCall);
  });

  it('consulta a flag com nome correto e default false', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (useFeatureFlag as any).mockReturnValue([false, vi.fn()]);
    renderHook(() => useCallBackend());
    expect(useFeatureFlag).toHaveBeenCalledWith('useWebRTCCall', false);
  });
});
