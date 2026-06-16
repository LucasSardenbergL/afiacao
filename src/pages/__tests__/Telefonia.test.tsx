import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

// Hooks/contextos mockados na borda — o objetivo é capturar QUAL userId a página
// repassa ao histórico de chamadas. Na lente "Ver como", deve ser o id do ALVO
// (effectiveUserId), nunca o do master logado.
const authMock = vi.fn();
const impMock = vi.fn();
const callBackendMock = vi.fn();

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authMock() }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/hooks/useCallBackend', () => ({ useCallBackend: () => callBackendMock() }));
vi.mock('@/hooks/useIsTelefoniaManager', () => ({ useIsTelefoniaManager: () => false }));
vi.mock('@/components/telefonia/DialPad', () => ({ DialPad: () => <div data-testid="dialpad" /> }));

// CallHistoryTabs mockado: registra o userId recebido a cada render.
const recebidoUserIds: (string | undefined)[] = [];
vi.mock('@/components/telefonia/CallHistoryTabs', () => ({
  CallHistoryTabs: ({ userId }: { userId: string | undefined }) => {
    recebidoUserIds.push(userId);
    return <div data-testid="call-history" data-userid={userId ?? ''} />;
  },
}));

import Telefonia from '@/pages/Telefonia';

const backendIdle = {
  backend: 'webrtc' as const,
  callState: 'idle',
  isActive: false,
  isConnecting: false,
  isRinging: false,
  isEstablished: false,
  isFinished: false,
  callDuration: 0,
  audioLink: null,
  error: null,
  makeCall: vi.fn(),
  endCall: vi.fn(),
  toggleMute: vi.fn(),
  isMuted: false,
  remoteStream: null,
  prerollPlaying: false,
  prerollEndsAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  recebidoUserIds.length = 0;
  callBackendMock.mockReturnValue(backendIdle);
});

describe('Telefonia — histórico respeita a lente "Ver como"', () => {
  it('na lente: passa o id do ALVO (effectiveUserId), não o do master logado', () => {
    authMock.mockReturnValue({ user: { id: 'master-id' } });
    impMock.mockReturnValue({ effectiveUserId: 'tatyana-id', isImpersonating: true });
    render(<Telefonia />);
    expect(recebidoUserIds.at(-1)).toBe('tatyana-id');
  });

  it('fora da lente: passa o id do próprio usuário', () => {
    authMock.mockReturnValue({ user: { id: 'master-id' } });
    impMock.mockReturnValue({ effectiveUserId: 'master-id', isImpersonating: false });
    render(<Telefonia />);
    expect(recebidoUserIds.at(-1)).toBe('master-id');
  });
});
