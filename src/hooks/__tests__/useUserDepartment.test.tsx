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
import { useUserDepartment } from '../useUserDepartment';

const mockedUseAuth = vi.mocked(useAuth);
const mockedFrom = vi.mocked(supabase.from);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useUserDepartment', () => {
  beforeEach(() => {
    mockedUseAuth.mockReset();
    mockedFrom.mockReset();
  });

  it('returns null when no user', () => {
    mockedUseAuth.mockReturnValue({ user: null } as ReturnType<typeof useAuth>);
    const { result } = renderHook(() => useUserDepartment(), { wrapper });
    expect(result.current.department).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('queries primary_dept when user present', async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-1' },
    } as ReturnType<typeof useAuth>);

    const maybeSingle = vi.fn().mockResolvedValue({ data: { department: 'comprador' } });
    const eqPrimary = vi.fn().mockReturnValue({ maybeSingle });
    const eqUser = vi.fn().mockReturnValue({ eq: eqPrimary });
    const select = vi.fn().mockReturnValue({ eq: eqUser });
    mockedFrom.mockReturnValue({ select } as unknown as ReturnType<typeof supabase.from>);

    const { result } = renderHook(() => useUserDepartment(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.department).toBe('comprador');
    expect(mockedFrom).toHaveBeenCalledWith('user_departments');
    expect(select).toHaveBeenCalledWith('department');
    expect(eqUser).toHaveBeenCalledWith('user_id', 'user-1');
    expect(eqPrimary).toHaveBeenCalledWith('primary_dept', true);
  });

  it('returns null when no row found', async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-2' },
    } as ReturnType<typeof useAuth>);

    const maybeSingle = vi.fn().mockResolvedValue({ data: null });
    const eqPrimary = vi.fn().mockReturnValue({ maybeSingle });
    const eqUser = vi.fn().mockReturnValue({ eq: eqPrimary });
    const select = vi.fn().mockReturnValue({ eq: eqUser });
    mockedFrom.mockReturnValue({ select } as unknown as ReturnType<typeof supabase.from>);

    const { result } = renderHook(() => useUserDepartment(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.department).toBeNull();
  });
});
