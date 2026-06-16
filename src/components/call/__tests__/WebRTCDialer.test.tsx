import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const claimCall = vi.fn();
const makeCall = vi.fn();

// Holder mutável acessível pelo factory do mock (hoisted), pra variar o estado do
// contexto (ocioso × ocupado) entre os testes.
const h = vi.hoisted(() => ({ ctx: null as unknown }));

vi.mock('@/contexts/webrtc-call-context', () => ({
  useWebRTCCallContextOptional: () => h.ctx,
}));

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

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

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    callState: 'idle',
    callDuration: 0,
    audioLink: null,
    error: null,
    isActive: false,
    isConnecting: false,
    isRinging: false,
    isEstablished: false,
    isFinished: false,
    remoteStream: null,
    isMuted: false,
    prerollPlaying: false,
    prerollEndsAt: null,
    callOwnerId: null,
    claimCall,
    makeCall,
    endCall: vi.fn(),
    toggleMute: vi.fn(),
    ...over,
  };
}

describe('WebRTCDialer — ownership por instância (sessão WebRTC é global)', () => {
  beforeEach(() => {
    claimCall.mockClear();
    makeCall.mockClear();
  });

  it('NÃO-dono fica idle mesmo com chamada global ativa (não vaza card nem onCallEnd)', () => {
    h.ctx = makeCtx({ callState: 'established', isActive: true, isEstablished: true, isFinished: true, callOwnerId: 'outro-dialer' });
    render(<WebRTCDialer phoneNumber="37999990000" customerName="Cliente A" />);
    const cdv = screen.getByTestId('cdv');
    expect(cdv.getAttribute('data-callstate')).toBe('idle');
    expect(cdv.getAttribute('data-isactive')).toBe('false');
    expect(cdv.getAttribute('data-isfinished')).toBe('false');
  });

  it('clicar Ligar com a sessão OCIOSA reivindica ownership e disca a própria linha', () => {
    h.ctx = makeCtx();
    render(<WebRTCDialer phoneNumber="37999990000" customerName="Cliente A" />);
    fireEvent.click(screen.getByText('ligar'));
    expect(claimCall).toHaveBeenCalledTimes(1);
    expect(makeCall).toHaveBeenCalledWith('37999990000');
  });

  it('clicar Ligar com OUTRA chamada ativa NÃO rouba a sessão (não reivindica nem disca)', () => {
    h.ctx = makeCtx({ callState: 'established', isActive: true, isEstablished: true, callOwnerId: 'outro-dialer' });
    render(<WebRTCDialer phoneNumber="37999990000" customerName="Cliente A" />);
    fireEvent.click(screen.getByText('ligar'));
    expect(claimCall).not.toHaveBeenCalled();
    expect(makeCall).not.toHaveBeenCalled();
  });
});
