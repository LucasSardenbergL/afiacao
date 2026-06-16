import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ImpersonationProvider, useImpersonation } from '@/contexts/ImpersonationContext';

const authMock = vi.fn();
const setLensActiveSpy = vi.fn();
const persistTargetSpy = vi.fn();
const loadPersistedSpy = vi.fn();

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authMock() }));
vi.mock('@/lib/impersonation/lens-write-guard', () => ({ setLensActive: (v: boolean) => setLensActiveSpy(v) }));
vi.mock('@/lib/impersonation/effective-user', () => ({
  loadPersistedTarget: () => loadPersistedSpy(),
  persistTarget: (t: unknown) => persistTargetSpy(t),
  resolveEffectiveUserId: (real: string | null, target: { id: string } | null) => target?.id ?? real,
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabaseUnguarded: { rpc: vi.fn().mockResolvedValue({ data: 'audit-1', error: null }) },
}));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

function View() {
  const { isImpersonating, effectiveUserId } = useImpersonation();
  return (
    <div>
      <span data-testid="imp">{String(isImpersonating)}</span>
      <span data-testid="eff">{effectiveUserId ?? ''}</span>
    </div>
  );
}

const TARGET = { id: 'regina-1', nome: 'Regina', grupo: 'farmer' as const };

beforeEach(() => {
  vi.clearAllMocks();
  loadPersistedSpy.mockReturnValue(TARGET);
});

describe('ImpersonationProvider — lente é master-only', () => {
  it('master com target persistido → impersonando (effectiveUserId = alvo)', () => {
    authMock.mockReturnValue({ user: { id: 'master-1' }, isMaster: true });
    render(<ImpersonationProvider><View /></ImpersonationProvider>);
    expect(screen.getByTestId('imp').textContent).toBe('true');
    expect(screen.getByTestId('eff').textContent).toBe('regina-1');
  });

  it('não-master com target persistido → NÃO impersona, e effectiveUserId não vaza pro alvo', () => {
    authMock.mockReturnValue({ user: { id: 'someone' }, isMaster: false });
    render(<ImpersonationProvider><View /></ImpersonationProvider>);
    expect(screen.getByTestId('imp').textContent).toBe('false');
    expect(screen.getByTestId('eff').textContent).toBe('someone');
  });

  it('deixar de ser master com a lente ativa → derruba a lente (guard off + persist limpo)', () => {
    authMock.mockReturnValue({ user: { id: 'master-1' }, isMaster: true });
    const { rerender } = render(<ImpersonationProvider><View /></ImpersonationProvider>);
    expect(screen.getByTestId('imp').textContent).toBe('true');
    // revogação de papel ao vivo / troca de sessão sem remount:
    authMock.mockReturnValue({ user: { id: 'master-1' }, isMaster: false });
    act(() => { rerender(<ImpersonationProvider><View /></ImpersonationProvider>); });
    expect(screen.getByTestId('imp').textContent).toBe('false');
    expect(setLensActiveSpy).toHaveBeenCalledWith(false);
    expect(persistTargetSpy).toHaveBeenCalledWith(null);
  });
});
