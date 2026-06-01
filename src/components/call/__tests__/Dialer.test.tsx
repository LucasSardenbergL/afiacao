import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../WebRTCDialer', () => ({
  WebRTCDialer: () => <div data-testid="webrtc-dialer">webrtc</div>,
}));
vi.mock('@/components/call/WebRTCDialer', () => ({
  WebRTCDialer: () => <div data-testid="webrtc-dialer">webrtc</div>,
}));

import { Dialer } from '../Dialer';

describe('Dialer', () => {
  it('renderiza SEMPRE o WebRTCDialer (Nvoip click-to-call descontinuado da UI)', async () => {
    render(<Dialer phoneNumber="37999998888" customerName="Cliente" />);
    // WebRTCDialer é lazy — espera resolver
    expect(await screen.findByTestId('webrtc-dialer')).toBeTruthy();
  });

  it('renderiza o WebRTCDialer também com floating=true', async () => {
    render(<Dialer phoneNumber="37999998888" customerName="Cliente" floating />);
    expect(await screen.findByTestId('webrtc-dialer')).toBeTruthy();
  });
});
