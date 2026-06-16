import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLeadingTrailingThrottle } from '@/lib/leading-trailing-throttle';

describe('createLeadingTrailingThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leading: o 1º fire executa imediatamente', () => {
    const fn = vi.fn();
    const t = createLeadingTrailingThrottle(fn, 3000);
    t.fire();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rajada dentro da janela colapsa num ÚNICO trailing ao fim dela', () => {
    const fn = vi.fn();
    const t = createLeadingTrailingThrottle(fn, 3000);
    t.fire(); // leading
    t.fire();
    t.fire();
    t.fire();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2999);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2); // trailing único
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(2); // nada mais pendente
  });

  it('a janela reabre após o trailing: fire seguinte volta a ser leading imediato', () => {
    const fn = vi.fn();
    const t = createLeadingTrailingThrottle(fn, 3000);
    t.fire(); // leading (t=0)
    t.fire(); // agenda trailing pra t=3000
    vi.advanceTimersByTime(3000); // trailing roda
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(3000); // janela do trailing expira
    t.fire();
    expect(fn).toHaveBeenCalledTimes(3); // leading de novo, sem esperar
  });

  it('fire com a janela já vazia executa na hora (não espera)', () => {
    const fn = vi.fn();
    const t = createLeadingTrailingThrottle(fn, 3000);
    t.fire();
    vi.advanceTimersByTime(5000);
    t.fire();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cancel descarta o trailing pendente sem executar', () => {
    const fn = vi.fn();
    const t = createLeadingTrailingThrottle(fn, 3000);
    t.fire(); // leading
    t.fire(); // agenda trailing
    t.cancel();
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(1); // só o leading rodou
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancel sem trailing pendente é no-op seguro', () => {
    const fn = vi.fn();
    const t = createLeadingTrailingThrottle(fn, 3000);
    expect(() => t.cancel()).not.toThrow();
    t.fire();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
