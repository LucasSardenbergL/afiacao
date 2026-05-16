import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { fromMock, maybeSingleMock, eqMock, selectMock } = vi.hoisted(() => {
  const maybeSingle = vi.fn();
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { fromMock: from, maybeSingleMock: maybeSingle, eqMock: eq, selectMock: select };
});

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: fromMock },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'test-user-id' } }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { critical: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { useUserRole } from '../useUserRole';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useUserRole — fail-closed contract', () => {
  it('returns role=null when supabase query returns error (fail-closed, not customer)', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'PostgrestError: connection refused' },
    });

    const { result } = renderHook(() => useUserRole());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.role).toBeNull();
    expect(result.current.isStaff).toBe(false);
    expect(result.current.isCustomer).toBe(false);
    expect(result.current.isAdmin).toBe(false);
  });

  it('returns role=null when supabase throws (catch path is fail-closed)', async () => {
    maybeSingleMock.mockRejectedValueOnce(new Error('Network down'));

    const { result } = renderHook(() => useUserRole());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.role).toBeNull();
    expect(result.current.isStaff).toBe(false);
    expect(result.current.isCustomer).toBe(false);
  });

  it('returns the actual role when query succeeds', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: { role: 'employee' },
      error: null,
    });

    const { result } = renderHook(() => useUserRole());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.role).toBe('employee');
    expect(result.current.isStaff).toBe(true);
    expect(result.current.isEmployee).toBe(true);
  });

  it('falls back to customer when data is empty but no error', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });

    const { result } = renderHook(() => useUserRole());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.role).toBe('customer');
    expect(result.current.isCustomer).toBe(true);
  });
});
