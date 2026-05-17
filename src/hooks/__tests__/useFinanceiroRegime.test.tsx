import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFinanceiroRegime } from '../useFinanceiroRegime';

describe('useFinanceiroRegime', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to competencia', () => {
    const { result } = renderHook(() => useFinanceiroRegime());
    expect(result.current.regime).toBe('competencia');
  });

  it('persists to localStorage when changed', () => {
    const { result } = renderHook(() => useFinanceiroRegime());
    act(() => result.current.setRegime('caixa'));
    expect(result.current.regime).toBe('caixa');
    expect(localStorage.getItem('financeiroRegime')).toBe('caixa');
  });

  it('reads existing localStorage value', () => {
    localStorage.setItem('financeiroRegime', 'caixa');
    const { result } = renderHook(() => useFinanceiroRegime());
    expect(result.current.regime).toBe('caixa');
  });
});
