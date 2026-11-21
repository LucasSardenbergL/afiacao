// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOrderDraft } from '@/hooks/useOrderDraft';

// Ciclo ÚNICO envelope × rascunho (follow-up Codex do #4042): o rascunho em disco precisa seguir
// o desfecho NA HORA — um autosave atrasado (600 ms) ressuscitaria o carrinho já enviado/gravado.
const CHAVE = 'order_draft:u1';
type Estado = { cart: string[] };

describe('useOrderDraft — clear e gravarAgora vencem o debounce', () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('clear() cancela o autosave em voo (não reescreve o rascunho apagado)', () => {
    const { result, rerender } = renderHook(
      ({ state }: { state: Estado }) => useOrderDraft({ scopeKey: 'u1', state, shouldSave: true }),
      { initialProps: { state: { cart: ['a'] } } },
    );
    rerender({ state: { cart: ['a', 'b'] } }); // agenda o timer
    act(() => { result.current.clear(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(localStorage.getItem(CHAVE)).toBeNull();
  });

  it('gravarAgora() grava síncrono e o timer antigo não sobrescreve com o carrinho velho', () => {
    const { result } = renderHook(() => useOrderDraft({ scopeKey: 'u1', state: { cart: ['oben', 'colacor'] }, shouldSave: true }));
    act(() => { result.current.gravarAgora({ cart: ['oben'] }); });
    // refresh ANTES do debounce: o disco já tem só a conta pendente
    expect(JSON.parse(localStorage.getItem(CHAVE) ?? 'null')?.state).toEqual({ cart: ['oben'] });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(JSON.parse(localStorage.getItem(CHAVE) ?? 'null')?.state).toEqual({ cart: ['oben'] });
  });
});
