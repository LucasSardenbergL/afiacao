import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ALL_COMPANIES } from '@/contexts/CompanyContext';

vi.mock('@/contexts/CompanyContext', async () => {
  const actual = await vi.importActual<typeof import('@/contexts/CompanyContext')>('@/contexts/CompanyContext');
  return { ...actual, useCompany: vi.fn() };
});

import { useCompany } from '@/contexts/CompanyContext';
import { useDashboardCompany } from '../useDashboardCompany';

const mockedUseCompany = vi.mocked(useCompany);

describe('useDashboardCompany', () => {
  beforeEach(() => mockedUseCompany.mockReset());

  it('returns single mode when selection is a Company', () => {
    mockedUseCompany.mockReturnValue({
      activeCompany: 'oben',
      selection: 'oben',
      setSelection: vi.fn(),
      setActiveCompany: vi.fn(),
      companyInfo: { id: 'oben', name: 'Oben', shortName: 'Oben', regime: 'presumido' },
    });
    const { result } = renderHook(() => useDashboardCompany());
    expect(result.current.mode).toBe('single');
    expect(result.current.companies).toEqual(['oben']);
    expect(result.current.primary).toBe('oben');
  });

  it('returns all mode when selection is "all"', () => {
    mockedUseCompany.mockReturnValue({
      activeCompany: 'colacor',
      selection: 'all',
      setSelection: vi.fn(),
      setActiveCompany: vi.fn(),
      companyInfo: { id: 'colacor', name: 'Colacor', shortName: 'Colacor', regime: 'presumido' },
    });
    const { result } = renderHook(() => useDashboardCompany());
    expect(result.current.mode).toBe('all');
    expect(result.current.companies).toEqual(ALL_COMPANIES);
    expect(result.current.primary).toBe('colacor');
  });
});
