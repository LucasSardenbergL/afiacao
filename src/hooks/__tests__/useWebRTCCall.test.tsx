import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
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
  },
  invokeMock: vi.fn(),
}));

vi.mock('@/lib/sip/sip-client', () => ({
  SipClient: vi.fn().mockImplementation(() => sipClientMock),
}));

vi.mock('@/lib/invoke-function', () => ({
  invokeFunction: invokeMock,
}));

import { useWebRTCCall } from '../useWebRTCCall';
import { WebRTCCallProvider } from '@/contexts/WebRTCCallContext';

const wrapper = ({ children }: { children: ReactNode }) => (
  <WebRTCCallProvider>{children}</WebRTCCallProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  invokeMock.mockResolvedValue({
    wsUri: 'wss://app.nvoip.com.br:7443',
    sipDomain: '54.233.253.44',
    username: '137973001',
    password: 'pw',
  });
});

describe('useWebRTCCall (consumer of WebRTCCallContext)', () => {
  it('retorna shape esperada da context value', () => {
    const { result } = renderHook(() => useWebRTCCall(), { wrapper });
    expect(result.current.callState).toBe('idle');
    expect(typeof result.current.makeCall).toBe('function');
    expect(typeof result.current.endCall).toBe('function');
    expect(result.current.isActive).toBe(false);
    expect(result.current.callId).toBeNull();
    expect(result.current.audioLink).toBeNull();
  });

  it('lança erro quando usado fora do WebRTCCallProvider', () => {
    const Probe = () => {
      useWebRTCCall();
      return null;
    };
    expectRenderToThrow(<Probe />, /WebRTCCallProvider/i);
  });
});
