import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

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

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
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

  it('múltiplos consumers compartilham o MESMO SipClient', async () => {
    const { result: hook1 } = renderHook(() => useWebRTCCallContext(), { wrapper });
    await waitFor(() => expect(SipClient).toHaveBeenCalledTimes(1));

    const { result: hook2 } = renderHook(() => useWebRTCCallContext(), { wrapper });

    expect(hook1.current).toBeDefined();
    expect(hook2.current).toBeDefined();
  });

  it('useWebRTCCallContext lança erro quando usado fora do Provider', () => {
    expect(() => renderHook(() => useWebRTCCallContext())).toThrow(
      /must be used within.*WebRTCCallProvider/i
    );
  });
});
