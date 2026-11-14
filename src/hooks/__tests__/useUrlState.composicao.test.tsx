// useUrlState: escritas em sequência no MESMO tick se compõem. O `setSearchParams(fn)` do
// react-router 6 entrega ao `fn` os params DO RENDER, não os da fila. Por isso o "Limpar filtros"
// de /sales (setSearch('') + setAccountFilter('all')) regravava o `q` antigo na 2ª chamada.
import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useUrlState } from '@/hooks/useUrlState';

function montar(url: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
  );
  return renderHook(
    () => {
      const [estado, set, reset] = useUrlState({ q: '', empresa: 'all' });
      return { estado, set, reset, search: useLocation().search };
    },
    { wrapper },
  );
}

describe('useUrlState — composição de escritas no mesmo tick', () => {
  it('duas chamadas parciais seguidas preservam AS DUAS mudanças', () => {
    const { result } = montar('/sales?q=serra&empresa=oben');
    act(() => {
      result.current.set({ q: '' });
      result.current.set({ empresa: 'all' });
    });
    expect(result.current.estado).toEqual({ q: '', empresa: 'all' });
    expect(result.current.search).toBe('?empresa=all'); // default não-vazio é serializado (comportamento atual)
  });

  it('updater funcional enxerga a escrita anterior ainda não renderizada', () => {
    const { result } = montar('/sales');
    act(() => {
      result.current.set({ q: 'lixa' });
      result.current.set((prev) => ({ ...prev, empresa: prev.q === 'lixa' ? 'colacor' : 'errado' }));
    });
    expect(result.current.estado).toEqual({ q: 'lixa', empresa: 'colacor' });
  });

  it('preserva param alheio e compõe reset seguido de escrita', () => {
    const { result } = montar('/sales?outro=1&q=serra&empresa=oben');
    act(() => {
      result.current.reset();
      result.current.set({ q: 'disco' });
    });
    expect(result.current.estado).toEqual({ q: 'disco', empresa: 'all' });
    expect(new URLSearchParams(result.current.search).get('outro')).toBe('1');
  });

  it('chamadas em ticks separados continuam funcionando', () => {
    const { result } = montar('/sales');
    act(() => result.current.set({ q: 'a' }));
    act(() => result.current.set({ empresa: 'oben' }));
    expect(result.current.estado).toEqual({ q: 'a', empresa: 'oben' });
  });
});
