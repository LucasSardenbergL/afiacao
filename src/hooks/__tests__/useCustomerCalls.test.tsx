import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { fromMock, orderMock, eqMock, notMock, limitMock, selectMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  selectMock: vi.fn(),
  eqMock: vi.fn(),
  notMock: vi.fn(),
  orderMock: vi.fn(),
  limitMock: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: fromMock },
}));

import { useCustomerCalls } from '../useCustomerCalls';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  const chain: Record<string, unknown> = {};
  chain.select = selectMock.mockReturnValue(chain);
  chain.eq = eqMock.mockReturnValue(chain);
  chain.not = notMock.mockReturnValue(chain);
  chain.order = orderMock.mockReturnValue(chain);
  chain.limit = limitMock.mockResolvedValue({ data: [], error: null });
  fromMock.mockReturnValue(chain);
});

describe('useCustomerCalls', () => {
  it('não roda query quando customerId é null', () => {
    const { result } = renderHook(() => useCustomerCalls(null), { wrapper });
    expect(result.current.isFetching).toBe(false);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('roda query quando customerId existe', async () => {
    limitMock.mockResolvedValueOnce({ data: [{ id: 'call-1' }], error: null });
    const { result } = renderHook(() => useCustomerCalls('cliente-1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(fromMock).toHaveBeenCalledWith('farmer_calls');
    expect(eqMock).toHaveBeenCalledWith('customer_user_id', 'cliente-1');
    expect(notMock).toHaveBeenCalledWith('transcript', 'is', null);
    expect(orderMock).toHaveBeenCalledWith('started_at', { ascending: false });
    expect(limitMock).toHaveBeenCalledWith(50);
  });

  it('retorna data vazia quando supabase retorna error', async () => {
    limitMock.mockResolvedValueOnce({ data: null, error: new Error('rls') });
    const { result } = renderHook(() => useCustomerCalls('cliente-1'), { wrapper });
    await waitFor(() => expect(result.current.isError || result.current.data === null).toBe(true));
  });
});
