import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { TranscriptTurn } from '@/lib/transcription/types';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@/lib/invoke-function', () => ({
  invokeFunction: invokeMock,
}));

import { useSpinAnalysis } from './useSpinAnalysis';

const fakeAnalysis = {
  spinStage: 'situation' as const,
  confidence: 0.8,
  whatClientRevealed: {
    situationFacts: ['usa PU mensalmente'],
    problemsAdmitted: [],
    implications: [],
    desiredOutcomes: [],
  },
  nextBestAction: {
    type: 'question' as const,
    spinType: 'problem' as const,
    exactPhrasing: 'Vocês têm tido problemas com o acabamento?',
    whyNow: 'Cliente já revelou volume; hora de buscar dor.',
  },
  risks: [],
  crossSellTriggers: [],
};

const turn = (overrides: Partial<TranscriptTurn> = {}): TranscriptTurn => ({
  id: `turn-${Math.random()}`,
  speaker: 'cliente',
  text: 'a gente usa uns 200 litros',
  isFinal: true,
  startedAt: Date.now(),
  endedAt: Date.now() + 1000,
  ...overrides,
});

beforeEach(() => {
  // shouldAdvanceTime: true keeps waitFor's internal polling alive when fake timers are active
  // (default behavior fakes setTimeout, which breaks @testing-library/react's waitFor polling)
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
  invokeMock.mockResolvedValue({ analysis: fakeAnalysis, usage: { inputTokens: 100, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0 } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSpinAnalysis', () => {
  it('estado inicial: status=idle, analysis=null', () => {
    const { result } = renderHook(() => useSpinAnalysis({ turns: [], enabled: false }));
    expect(result.current.status).toBe('idle');
    expect(result.current.analysis).toBeNull();
  });

  it('quando enabled=false: não chama edge mesmo com turnos finais', () => {
    renderHook(() =>
      useSpinAnalysis({
        turns: [turn({ speaker: 'cliente', isFinal: true })],
        enabled: false,
      })
    );
    vi.advanceTimersByTime(10_000);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('dispara análise debounced 3s após novo turno final do CLIENTE', async () => {
    const { result, rerender } = renderHook(
      ({ turns }) => useSpinAnalysis({ turns, enabled: true }),
      { initialProps: { turns: [] as TranscriptTurn[] } }
    );

    rerender({ turns: [turn({ speaker: 'cliente', isFinal: true })] });
    // Antes de 3s: nada
    vi.advanceTimersByTime(2900);
    expect(invokeMock).not.toHaveBeenCalled();

    // Após 3s: dispara
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('claude-spin-analyze', expect.objectContaining({ turns: expect.any(Array) })));
    await waitFor(() => expect(result.current.analysis).toEqual(fakeAnalysis));
    expect(result.current.status).toBe('ready');
  });

  it('NÃO dispara análise pra turno do VENDEDOR isolado', () => {
    const { rerender } = renderHook(
      ({ turns }) => useSpinAnalysis({ turns, enabled: true }),
      { initialProps: { turns: [] as TranscriptTurn[] } }
    );

    rerender({ turns: [turn({ speaker: 'vendedor', isFinal: true })] });
    vi.advanceTimersByTime(10_000);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('NÃO dispara em turnos interim (isFinal=false)', () => {
    const { rerender } = renderHook(
      ({ turns }) => useSpinAnalysis({ turns, enabled: true }),
      { initialProps: { turns: [] as TranscriptTurn[] } }
    );
    rerender({ turns: [turn({ speaker: 'cliente', isFinal: false })] });
    vi.advanceTimersByTime(10_000);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('debounce: 2 turnos finais cliente em rajada → 1 chamada só após 3s do último', async () => {
    const { rerender } = renderHook(
      ({ turns }) => useSpinAnalysis({ turns, enabled: true }),
      { initialProps: { turns: [] as TranscriptTurn[] } }
    );

    const t1 = turn({ speaker: 'cliente', isFinal: true, text: 'primeiro' });
    rerender({ turns: [t1] });
    vi.advanceTimersByTime(2000);

    const t2 = turn({ speaker: 'cliente', isFinal: true, text: 'segundo' });
    rerender({ turns: [t1, t2] });
    vi.advanceTimersByTime(2900);
    expect(invokeMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
  });
});
