import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

import { supabase } from '@/integrations/supabase/client';
import { useAuditTrail } from '../useAuditTrail';

const mockedFrom = vi.mocked(supabase.from);

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

beforeEach(() => {
  mockedFrom.mockReset();
});

describe('useAuditTrail', () => {
  it('returns disabled query when rowId is empty', () => {
    const { result } = renderHook(
      () => useAuditTrail({ tableName: 'fin_contas_receber', rowId: '' }),
      { wrapper },
    );
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it('returns disabled query when tableName is empty', () => {
    const { result } = renderHook(
      () => useAuditTrail({ tableName: '', rowId: 'some-id' }),
      { wrapper },
    );
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it('queries fin_audit_log when both params provided', async () => {
    const mockData = [
      {
        id: 1,
        table_name: 'fin_contas_receber',
        row_id: 'row-1',
        op: 'UPDATE',
        changed_fields: { valor: { before: 100, after: 150 } },
        changed_by: 'user-1',
        changed_at: '2026-05-17T12:00:00Z',
        company: 'colacor',
        origem: 'manual',
        period_ref: '2026-05',
        override_justificativa: null,
      },
    ];

    const limitFn = vi.fn().mockResolvedValue({ data: mockData, error: null });
    const orderFn = vi.fn().mockReturnValue({ limit: limitFn });
    const eq2Fn = vi.fn().mockReturnValue({ order: orderFn });
    const eq1Fn = vi.fn().mockReturnValue({ eq: eq2Fn });
    const selectFn = vi.fn().mockReturnValue({ eq: eq1Fn });
    mockedFrom.mockReturnValue({ select: selectFn } as unknown as ReturnType<typeof supabase.from>);

    const { result } = renderHook(
      () => useAuditTrail({ tableName: 'fin_contas_receber', rowId: 'row-1' }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].op).toBe('UPDATE');
    expect(mockedFrom).toHaveBeenCalledWith('fin_audit_log');
    expect(eq1Fn).toHaveBeenCalledWith('table_name', 'fin_contas_receber');
    expect(eq2Fn).toHaveBeenCalledWith('row_id', 'row-1');
  });
});
