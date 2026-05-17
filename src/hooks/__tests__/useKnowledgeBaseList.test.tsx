import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { fromMock, selectMock, inMock, eqMock, orderMock, limitMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  selectMock: vi.fn(),
  inMock: vi.fn(),
  eqMock: vi.fn(),
  orderMock: vi.fn(),
  limitMock: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: fromMock },
}));

import { useKnowledgeBaseList } from '../useKnowledgeBaseList';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  const chain: Record<string, unknown> = {};
  chain.select = selectMock.mockReturnValue(chain);
  chain.in = inMock.mockReturnValue(chain);
  chain.eq = eqMock.mockReturnValue(chain);
  chain.order = orderMock.mockReturnValue(chain);
  chain.limit = limitMock.mockResolvedValue({ data: [], error: null });
  fromMock.mockReturnValue(chain);
});

describe('useKnowledgeBaseList', () => {
  it('default: filtra por status ready|processing', async () => {
    const { result } = renderHook(() => useKnowledgeBaseList(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(fromMock).toHaveBeenCalledWith('kb_documents');
    expect(inMock).toHaveBeenCalledWith('status', ['ready', 'processing']);
    expect(orderMock).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(limitMock).toHaveBeenCalledWith(100);
  });

  it('com filter type aplica eq', async () => {
    renderHook(() => useKnowledgeBaseList({ type: 'boletim_tecnico' }), { wrapper });
    await waitFor(() => expect(eqMock).toHaveBeenCalledWith('type', 'boletim_tecnico'));
  });

  it('com filter supplier aplica eq', async () => {
    renderHook(() => useKnowledgeBaseList({ supplier: 'sayerlack' }), { wrapper });
    await waitFor(() => expect(eqMock).toHaveBeenCalledWith('supplier', 'sayerlack'));
  });
});
