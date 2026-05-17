import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { engineMock, invokeMock } = vi.hoisted(() => {
  const handlers: Record<string, ((data: unknown) => void)[]> = {};
  return {
    engineMock: {
      TranscriptionEngine: vi.fn().mockImplementation(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        on: vi.fn((event: string, handler: (data: unknown) => void) => {
          (handlers[event] ??= []).push(handler);
        }),
        _trigger: (event: string, data: unknown) => {
          for (const h of handlers[event] ?? []) h(data);
        },
      })),
      _handlers: handlers,
    },
    invokeMock: vi.fn(),
  };
});

vi.mock('@/lib/transcription/transcription-engine', () => ({
  TranscriptionEngine: engineMock.TranscriptionEngine,
}));

vi.mock('@/lib/invoke-function', () => ({
  invokeFunction: invokeMock,
}));

import { useTranscription } from '../useTranscription';

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(engineMock._handlers).forEach((k) => delete engineMock._handlers[k]);
  invokeMock.mockResolvedValue({ key: 'temp_key_abc', expiresAt: '2026-12-31T00:00:00Z' });
});

describe('useTranscription', () => {
  it('estado inicial é idle, turns vazio', () => {
    const { result } = renderHook(() =>
      useTranscription({ vendorStream: null, clientStream: null, enabled: false })
    );
    expect(result.current.status).toBe('idle');
    expect(result.current.turns).toEqual([]);
  });

  it('quando enabled+streams disponíveis: fetcha token e inicia engine', async () => {
    const { result } = renderHook(() =>
      useTranscription({
        vendorStream: new MediaStream(),
        clientStream: new MediaStream(),
        enabled: true,
      })
    );

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('deepgram-token', {}));
    await waitFor(() => expect(engineMock.TranscriptionEngine).toHaveBeenCalled());
    await waitFor(() => expect(result.current.status).toBe('active'));
  });

  it('eventos turn do engine atualizam turns array', async () => {
    const { result } = renderHook(() =>
      useTranscription({
        vendorStream: new MediaStream(),
        clientStream: new MediaStream(),
        enabled: true,
      })
    );

    await waitFor(() => expect(result.current.status).toBe('active'));

    act(() => {
      const handlers = engineMock._handlers['turn'] ?? [];
      handlers[0]?.({
        id: 'vendedor-1',
        speaker: 'vendedor',
        text: 'olá',
        isFinal: false,
        startedAt: Date.now(),
        endedAt: null,
      });
    });

    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0].text).toBe('olá');
  });

  it('interim updates do mesmo turno (mesmo id) substituem em vez de duplicar', async () => {
    const { result } = renderHook(() =>
      useTranscription({
        vendorStream: new MediaStream(),
        clientStream: new MediaStream(),
        enabled: true,
      })
    );

    await waitFor(() => expect(result.current.status).toBe('active'));
    const startedAt = Date.now();

    act(() => {
      const handlers = engineMock._handlers['turn'] ?? [];
      handlers[0]?.({
        id: 'vendedor-1',
        speaker: 'vendedor',
        text: 'olá',
        isFinal: false,
        startedAt,
        endedAt: null,
      });
      handlers[0]?.({
        id: 'vendedor-1',
        speaker: 'vendedor',
        text: 'olá, tudo bem?',
        isFinal: true,
        startedAt: startedAt + 100, // engine pode mandar startedAt atualizado
        endedAt: startedAt + 500,
      });
    });

    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0].text).toBe('olá, tudo bem?');
    expect(result.current.turns[0].isFinal).toBe(true);
    // Preserva startedAt do PRIMEIRO interim, não do update
    expect(result.current.turns[0].startedAt).toBe(startedAt);
  });

  it('quando enabled=false: status fica idle, engine não inicia', () => {
    renderHook(() =>
      useTranscription({
        vendorStream: new MediaStream(),
        clientStream: new MediaStream(),
        enabled: false,
      })
    );
    expect(engineMock.TranscriptionEngine).not.toHaveBeenCalled();
  });
});
