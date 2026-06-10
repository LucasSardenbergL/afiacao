import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retorna o valor inicial imediatamente (sem esperar o delay)', () => {
    const { result } = renderHook(() => useDebouncedValue('a', 300));
    expect(result.current).toBe('a');
  });

  it('não propaga mudança antes do delay', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'ab' });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe('a');
  });

  it('propaga a mudança após o delay', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'ab' });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe('ab');
  });

  it('colapsa rajada de digitação: só o último valor vence, sem passar pelos intermediários', () => {
    const observados: string[] = [];
    const { result, rerender } = renderHook(
      ({ v }) => {
        const d = useDebouncedValue(v, 300);
        observados.push(d);
        return d;
      },
      { initialProps: { v: '' } },
    );

    // digita "abc" com 100ms entre teclas — cada tecla reseta o timer
    rerender({ v: 'a' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ v: 'ab' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ v: 'abc' });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current).toBe('abc');
    // nunca emitiu os valores intermediários 'a'/'ab' como debounced
    expect(observados).not.toContain('a');
    expect(observados).not.toContain('ab');
  });

  it('usa o delay default de 300ms quando não informado', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v), {
      initialProps: { v: 1 },
    });
    rerender({ v: 2 });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(2);
  });

  it('cancela o timer pendente no unmount (não vaza setState pós-unmount)', () => {
    const spy = vi.spyOn(window, 'clearTimeout');
    const { rerender, unmount } = renderHook(({ v }) => useDebouncedValue(v, 300), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'ab' });
    unmount();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
