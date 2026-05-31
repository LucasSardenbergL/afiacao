import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Contexto WebRTC controlável. callOwnerId NÃO bate com o useId interno do dialer,
// então o dialer renderizado é sempre um NÃO-dono — mesmo com chamada global ativa.
const claimCall = vi.fn();
const makeCall = vi.fn();
const ctx = {
  callState: 'established',
  callDuration: 42,
  audioLink: null,
  error: null,
  isActive: true,
  isConnecting: false,
  isRinging: false,
  isEstablished: true,
  isFinished: true,
  remoteStream: null,
  isMuted: false,
  prerollPlaying: true,
  prerollEndsAt: 123,
  callOwnerId: 'outro-dialer',
  claimCall,
  makeCall,
  endCall: vi.fn(),
  toggleMute: vi.fn(),
};

vi.mock('@/contexts/WebRTCCallContext', () => ({
  useWebRTCCallContextOptional: () => ctx,
}));

// Stub do CallDialerView expondo as props que importam pro ownership.
vi.mock('../CallDialerView', () => ({
  CallDialerView: (p: {
    callState: string;
    isActive: boolean;
    isFinished: boolean;
    onMakeCall: () => void;
  }) => (
    <div
      data-testid="cdv"
      data-callstate={p.callState}
      data-isactive={String(p.isActive)}
      data-isfinished={String(p.isFinished)}
    >
      <button onClick={p.onMakeCall}>ligar</button>
    </div>
  ),
}));

import { WebRTCDialer } from '../WebRTCDialer';

describe('WebRTCDialer — ownership por instância (sessão WebRTC é global)', () => {
  beforeEach(() => {
    claimCall.mockClear();
    makeCall.mockClear();
  });

  it('NÃO-dono fica idle mesmo com chamada global ativa (não vaza card nem onCallEnd)', () => {
    render(<WebRTCDialer phoneNumber="37999990000" customerName="Cliente A" />);
    const cdv = screen.getByTestId('cdv');
    // Apesar do contexto estar 'established'/isFinished, este dialer (não-dono) recebe idle.
    expect(cdv.getAttribute('data-callstate')).toBe('idle');
    expect(cdv.getAttribute('data-isactive')).toBe('false');
    expect(cdv.getAttribute('data-isfinished')).toBe('false');
  });

  it('clicar Ligar reivindica ownership e disca o telefone da própria linha', () => {
    render(<WebRTCDialer phoneNumber="37999990000" customerName="Cliente A" />);
    fireEvent.click(screen.getByText('ligar'));
    expect(claimCall).toHaveBeenCalledTimes(1);
    expect(makeCall).toHaveBeenCalledWith('37999990000');
  });
});
