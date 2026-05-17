import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePeriodOverride } from '../usePeriodOverride';
import type { ReactNode } from 'react';

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe('usePeriodOverride', () => {
  it('exports openOverride and activeOverride', () => {
    const { result } = renderHook(() => usePeriodOverride('colacor'), { wrapper });
    expect(typeof result.current.openOverride).toBe('object'); // useMutation returns object
    expect('activeOverride' in result.current).toBe(true);
  });
});
