import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useFeatureFlag', () => ({
  useFeatureFlag: vi.fn(),
}));

vi.mock('@/components/NvoipDialer', () => ({
  NvoipDialer: () => <div data-testid="nvoip-dialer">nvoip</div>,
  NvoipFloatingDialer: () => <div data-testid="nvoip-floating-dialer">nvoip-floating</div>,
}));

vi.mock('../WebRTCDialer', () => ({
  WebRTCDialer: () => <div data-testid="webrtc-dialer">webrtc</div>,
}));
vi.mock('@/components/call/WebRTCDialer', () => ({
  WebRTCDialer: () => <div data-testid="webrtc-dialer">webrtc</div>,
}));

import { Dialer } from '../Dialer';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';

describe('Dialer dispatcher', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renderiza NvoipDialer quando flag off (default)', () => {
    (useFeatureFlag as any).mockReturnValue([false, vi.fn()]);
    render(<Dialer phoneNumber="37999998888" customerName="Cliente" />);
    expect(screen.getByTestId('nvoip-dialer')).toBeTruthy();
    expect(screen.queryByTestId('webrtc-dialer')).toBeNull();
  });

  it('renderiza NvoipFloatingDialer quando flag off + floating=true', () => {
    (useFeatureFlag as any).mockReturnValue([false, vi.fn()]);
    render(<Dialer phoneNumber="37999998888" customerName="Cliente" floating />);
    expect(screen.getByTestId('nvoip-floating-dialer')).toBeTruthy();
    expect(screen.queryByTestId('nvoip-dialer')).toBeNull();
  });

  it('renderiza WebRTCDialer quando flag on', async () => {
    (useFeatureFlag as any).mockReturnValue([true, vi.fn()]);
    render(<Dialer phoneNumber="37999998888" customerName="Cliente" />);
    // WebRTCDialer é lazy — espera resolver
    expect(await screen.findByTestId('webrtc-dialer')).toBeTruthy();
    expect(screen.queryByTestId('nvoip-dialer')).toBeNull();
  });

  it('passa a feature flag corretamente', () => {
    (useFeatureFlag as any).mockReturnValue([false, vi.fn()]);
    render(<Dialer phoneNumber="37999998888" customerName="Cliente" />);
    expect(useFeatureFlag).toHaveBeenCalledWith('useWebRTCCall', false);
  });
});
