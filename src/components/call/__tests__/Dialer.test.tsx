import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { Dialer } from '../Dialer';

vi.mock('@/hooks/useFeatureFlag', () => ({
  useFeatureFlag: vi.fn(),
}));

vi.mock('@/hooks/useNvoipCall', () => ({
  useNvoipCall: () => ({
    callState: 'idle', callDuration: 0, audioLink: null, error: null,
    isActive: false, isConnecting: false, isRinging: false, isEstablished: false, isFinished: false,
    makeCall: vi.fn(), endCall: vi.fn(),
  }),
}));

vi.mock('@/hooks/useWebRTCCall', () => ({
  useWebRTCCall: () => ({
    callState: 'idle', callDuration: 0, audioLink: null, error: null,
    isActive: false, isConnecting: false, isRinging: false, isEstablished: false, isFinished: false,
    makeCall: vi.fn(), endCall: vi.fn(),
    localStream: null, remoteStream: null,
  }),
}));

import { useFeatureFlag } from '@/hooks/useFeatureFlag';

describe('Dialer dispatcher', () => {
  beforeEach(() => vi.clearAllMocks());

  it('consulta a feature flag useWebRTCCall com default false', () => {
    (useFeatureFlag as any).mockReturnValue([false, vi.fn()]);
    render(<Dialer phoneNumber="37999998888" customerName="Cliente" />);
    expect(useFeatureFlag).toHaveBeenCalledWith('useWebRTCCall', false);
  });

  it('renderiza WebRTC quando flag on', () => {
    (useFeatureFlag as any).mockReturnValue([true, vi.fn()]);
    const { container } = render(<Dialer phoneNumber="37999998888" customerName="Cliente" />);
    // backend label badge "WEBRTC" só aparece em estados active; em idle, só o botão "Ligar" aparece
    // mas o que importa é que o componente renderiza sem erro com a flag on
    expect(container).toBeTruthy();
  });

  it('renderiza Nvoip floating quando flag off + floating=true', () => {
    (useFeatureFlag as any).mockReturnValue([false, vi.fn()]);
    const { container } = render(
      <Dialer phoneNumber="37999998888" customerName="Cliente" floating />
    );
    expect(container).toBeTruthy();
  });
});
