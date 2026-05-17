import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useLastVisit } from '../useLastVisit';

const mockedUseAuth = vi.mocked(useAuth);
const mockedFrom = vi.mocked(supabase.from);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  mockedUseAuth.mockReset();
  mockedFrom.mockReset();
  localStorage.clear();
});

describe('useLastVisit', () => {
  it('returns null when no user and no localStorage', () => {
    mockedUseAuth.mockReturnValue({ user: null } as ReturnType<typeof useAuth>);
    const { result } = renderHook(() => useLastVisit(), { wrapper });
    expect(result.current.lastVisitIso).toBeNull();
    expect(result.current.minutesSinceLastVisit).toBeNull();
  });

  it('falls back to localStorage when no user', () => {
    const iso = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h atrás
    localStorage.setItem('dashboardLastVisit', iso);
    mockedUseAuth.mockReturnValue({ user: null } as ReturnType<typeof useAuth>);
    const { result } = renderHook(() => useLastVisit(), { wrapper });
    expect(result.current.lastVisitIso).toBe(iso);
    expect(result.current.minutesSinceLastVisit).toBeGreaterThanOrEqual(60);
  });

  it('queries previous visit when user present', async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-1' },
    } as ReturnType<typeof useAuth>);

    const serverIso = new Date(Date.now() - 120 * 60_000).toISOString();
    const maybeSingle = vi.fn().mockResolvedValue({ data: { visited_at: serverIso } });
    const rangeFn = vi.fn().mockReturnValue({ maybeSingle });
    const orderFn = vi.fn().mockReturnValue({ range: rangeFn });
    const eqFn = vi.fn().mockReturnValue({ order: orderFn });
    const selectFn = vi.fn().mockReturnValue({ eq: eqFn });
    mockedFrom.mockReturnValue({ select: selectFn } as unknown as ReturnType<typeof supabase.from>);

    const { result } = renderHook(() => useLastVisit(), { wrapper });

    await waitFor(() => expect(result.current.lastVisitIso).toBe(serverIso));
    expect(result.current.minutesSinceLastVisit).toBeGreaterThanOrEqual(120);
    expect(mockedFrom).toHaveBeenCalledWith('dashboard_visits');
    expect(eqFn).toHaveBeenCalledWith('user_id', 'user-1');
    expect(rangeFn).toHaveBeenCalledWith(1, 1);
  });

  it('server visit wins over localStorage when both available', async () => {
    const localIso = new Date(Date.now() - 30 * 60_000).toISOString();
    const serverIso = new Date(Date.now() - 180 * 60_000).toISOString();
    localStorage.setItem('dashboardLastVisit', localIso);
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-2' },
    } as ReturnType<typeof useAuth>);

    const maybeSingle = vi.fn().mockResolvedValue({ data: { visited_at: serverIso } });
    const rangeFn = vi.fn().mockReturnValue({ maybeSingle });
    const orderFn = vi.fn().mockReturnValue({ range: rangeFn });
    const eqFn = vi.fn().mockReturnValue({ order: orderFn });
    const selectFn = vi.fn().mockReturnValue({ eq: eqFn });
    mockedFrom.mockReturnValue({ select: selectFn } as unknown as ReturnType<typeof supabase.from>);

    const { result } = renderHook(() => useLastVisit(), { wrapper });
    await waitFor(() => expect(result.current.lastVisitIso).toBe(serverIso));
  });

  it('falls back to localStorage when server returns null', async () => {
    const localIso = new Date(Date.now() - 45 * 60_000).toISOString();
    localStorage.setItem('dashboardLastVisit', localIso);
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-3' },
    } as ReturnType<typeof useAuth>);

    const maybeSingle = vi.fn().mockResolvedValue({ data: null });
    const rangeFn = vi.fn().mockReturnValue({ maybeSingle });
    const orderFn = vi.fn().mockReturnValue({ range: rangeFn });
    const eqFn = vi.fn().mockReturnValue({ order: orderFn });
    const selectFn = vi.fn().mockReturnValue({ eq: eqFn });
    mockedFrom.mockReturnValue({ select: selectFn } as unknown as ReturnType<typeof supabase.from>);

    const { result } = renderHook(() => useLastVisit(), { wrapper });
    // Espera resolver a query (resolve com null), depois cai pro local
    await waitFor(() => expect(result.current.lastVisitIso).toBe(localIso));
  });
});
