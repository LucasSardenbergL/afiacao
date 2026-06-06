import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMyCommercialRole } from '@/hooks/useMyCommercialRole';

const authMock = vi.fn();
const impMock = vi.fn();
const profileMock = vi.fn();
const maybeSingleMock = vi.fn();

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authMock() }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/hooks/useImpersonatedAccessProfile', () => ({ useImpersonatedAccessProfile: () => profileMock() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => maybeSingleMock() }) }) }) },
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockReturnValue({ user: { id: 'master-1' } });
  impMock.mockReturnValue({ isImpersonating: false });
  profileMock.mockReturnValue({ data: null, isLoading: false });
  maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'master' } });
});

describe('useMyCommercialRole', () => {
  it('sem lente: retorna o role real consultado', async () => {
    const { result } = renderHook(() => useMyCommercialRole(), { wrapper });
    await waitFor(() => expect(result.current.data).toBe('master'));
  });

  it('na lente: retorna o commercial_role do ALVO sem consultar o do master', async () => {
    impMock.mockReturnValue({ isImpersonating: true });
    profileMock.mockReturnValue({ data: { commercialRole: 'farmer' }, isLoading: false });
    const { result } = renderHook(() => useMyCommercialRole(), { wrapper });
    expect(result.current.data).toBe('farmer');
    expect(maybeSingleMock).not.toHaveBeenCalled();
  });

  it('na lente, perfil do alvo carregando: isLoading=true', () => {
    impMock.mockReturnValue({ isImpersonating: true });
    profileMock.mockReturnValue({ data: null, isLoading: true });
    const { result } = renderHook(() => useMyCommercialRole(), { wrapper });
    expect(result.current.isLoading).toBe(true);
  });
});
