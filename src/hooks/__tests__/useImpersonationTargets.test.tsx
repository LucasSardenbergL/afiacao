import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useImpersonationTargets } from '@/hooks/useImpersonationTargets';

const authMock = vi.fn();
const rpcMock = vi.fn();
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authMock() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockReturnValue({ isMaster: true, user: { id: 'master-1' } });
  rpcMock.mockResolvedValue({
    data: [
      // a RPC list_impersonation_targets devolve TODOS os donos de carteira — inclusive
      // o próprio master, que costuma ter carteira própria.
      { user_id: 'master-1', nome: 'Lucas (master)', commercial_role: 'super_admin' },
      { user_id: 'regina-1', nome: 'Regina', commercial_role: 'farmer' },
      { user_id: 'tatiana-1', nome: 'Tatiana', commercial_role: 'hunter' },
    ],
    error: null,
  });
});

describe('useImpersonationTargets', () => {
  it('exclui o próprio master da lista (não "ver como você mesmo")', async () => {
    const { result } = renderHook(() => useImpersonationTargets(), { wrapper });
    await waitFor(() => expect(result.current.data?.length).toBe(2));
    const ids = (result.current.data ?? []).map((t) => t.id);
    expect(ids).not.toContain('master-1'); // o master sumiu da lista
    expect(ids).toEqual(['regina-1', 'tatiana-1']); // só os outros donos de carteira
  });

  it('mapeia o grupo (hunter/farmer)', async () => {
    const { result } = renderHook(() => useImpersonationTargets(), { wrapper });
    await waitFor(() => expect(result.current.data?.length).toBe(2));
    const byId = Object.fromEntries((result.current.data ?? []).map((t) => [t.id, t.grupo]));
    expect(byId['regina-1']).toBe('farmer');
    expect(byId['tatiana-1']).toBe('hunter');
  });
});
