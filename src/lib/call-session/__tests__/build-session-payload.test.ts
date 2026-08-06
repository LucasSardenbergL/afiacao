import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../aggregate-entities', () => ({
  aggregateEntities: vi.fn(() => ({ produtos: ['lixa'] })),
}));

import { buildSessionPayload, type BuildSessionPayloadInput } from '../build-session-payload';
import { aggregateEntities } from '../aggregate-entities';
import type { TranscriptTurn } from '@/lib/transcription/types';
import type { SpinAnalysis } from '@/lib/call/spin/types';

const mockAggregate = vi.mocked(aggregateEntities);

function turn(over: Partial<TranscriptTurn> = {}): TranscriptTurn {
  return {
    id: 'turn-1',
    speaker: 'vendedor',
    text: 'olá',
    isFinal: true,
    startedAt: 1000,
    endedAt: 2000,
    ...over,
  } as unknown as TranscriptTurn;
}

const analyses = [{ tag: 'a' }] as unknown as SpinAnalysis[];

function makeInput(over: Partial<BuildSessionPayloadInput> = {}): BuildSessionPayloadInput {
  return {
    farmerId: 'farmer-1',
    customerUserId: 'cust-1',
    phoneDialed: '37999998888',
    callBackend: 'webrtc',
    startedAt: new Date('2026-05-26T10:00:00.000Z'),
    endedAt: new Date('2026-05-26T10:02:30.000Z'), // +150s
    turns: [turn()],
    analyses,
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('buildSessionPayload', () => {
  it('calcula duration_seconds (arredondado) e serializa timestamps em ISO', () => {
    const p = buildSessionPayload(makeInput());
    expect(p.duration_seconds).toBe(150);
    expect(p.started_at).toBe('2026-05-26T10:00:00.000Z');
    expect(p.ended_at).toBe('2026-05-26T10:02:30.000Z');
  });

  it('duração negativa (ended antes de started) → 0', () => {
    const p = buildSessionPayload(makeInput({
      startedAt: new Date('2026-05-26T10:05:00.000Z'),
      endedAt: new Date('2026-05-26T10:00:00.000Z'),
    }));
    expect(p.duration_seconds).toBe(0);
  });

  it('arredonda sub-segundo', () => {
    const p = buildSessionPayload(makeInput({
      startedAt: new Date(0),
      endedAt: new Date(2600), // 2.6s → 3
    }));
    expect(p.duration_seconds).toBe(3);
  });

  it('transcript fica "lite" — só speaker/text/isFinal/startedAt (dropa id/endedAt)', () => {
    const p = buildSessionPayload(makeInput({ turns: [turn({ id: 'x', text: 'oi', endedAt: 9999 })] }));
    expect(p.transcript).toEqual([{ speaker: 'vendedor', text: 'oi', isFinal: true, startedAt: 1000 }]);
  });

  it('entities_extracted vem do aggregateEntities (chamado com as analyses)', () => {
    const p = buildSessionPayload(makeInput());
    expect(mockAggregate).toHaveBeenCalledWith(analyses);
    expect(p.entities_extracted).toEqual({ produtos: ['lixa'] });
  });

  it('passa analyses cru e os campos identificadores adiante', () => {
    const p = buildSessionPayload(makeInput());
    expect(p.analyses).toBe(analyses);
    expect(p).toMatchObject({
      farmer_id: 'farmer-1',
      customer_user_id: 'cust-1',
      phone_dialed: '37999998888',
      call_backend: 'webrtc',
    });
  });

  it('defaults conservadores: call_type=venda, call_result=atendeu', () => {
    const p = buildSessionPayload(makeInput());
    expect(p.call_type).toBe('venda');
    expect(p.call_result).toBe('atendeu');
  });
});
