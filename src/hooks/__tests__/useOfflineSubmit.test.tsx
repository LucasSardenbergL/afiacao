import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

import { useOfflineSubmit } from '../useOfflineSubmit';

beforeEach(() => vi.clearAllMocks());

describe('useOfflineSubmit', () => {
  it('online: onSubmit chama submit', () => {
    const submit = vi.fn();
    const { result } = renderHook(() => useOfflineSubmit({ submit, online: true, hasContent: true }));
    act(() => result.current.onSubmit());
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.current.offline).toBe(false);
    expect(result.current.showReconnectCta).toBe(false);
  });

  it('offline: onSubmit NÃO chama submit e marca offline', () => {
    const submit = vi.fn();
    const { result } = renderHook(() => useOfflineSubmit({ submit, online: false, hasContent: true }));
    act(() => result.current.onSubmit());
    expect(submit).not.toHaveBeenCalled();
    expect(result.current.offline).toBe(true);
  });

  it('offline→online com intent pendente + conteúdo → mostra CTA de reconexão', () => {
    const submit = vi.fn();
    const { result, rerender } = renderHook(
      ({ online }: { online: boolean }) => useOfflineSubmit({ submit, online, hasContent: true }),
      { initialProps: { online: false } },
    );
    act(() => result.current.onSubmit()); // clica offline → pendente
    expect(result.current.showReconnectCta).toBe(false); // ainda offline
    rerender({ online: true }); // reconecta
    expect(result.current.showReconnectCta).toBe(true);
  });

  it('CTA de reconexão chama submit e some depois', () => {
    const submit = vi.fn();
    const { result, rerender } = renderHook(
      ({ online }: { online: boolean }) => useOfflineSubmit({ submit, online, hasContent: true }),
      { initialProps: { online: false } },
    );
    act(() => result.current.onSubmit());
    rerender({ online: true });
    expect(result.current.showReconnectCta).toBe(true);
    act(() => result.current.onReconnectSubmit());
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.current.showReconnectCta).toBe(false);
  });

  it('sem conteúdo: nunca mostra CTA mesmo com intent pendente', () => {
    const submit = vi.fn();
    const { result, rerender } = renderHook(
      ({ online, hasContent }: { online: boolean; hasContent: boolean }) =>
        useOfflineSubmit({ submit, online, hasContent }),
      { initialProps: { online: false, hasContent: true } },
    );
    act(() => result.current.onSubmit());
    rerender({ online: true, hasContent: false });
    expect(result.current.showReconnectCta).toBe(false);
  });
});
