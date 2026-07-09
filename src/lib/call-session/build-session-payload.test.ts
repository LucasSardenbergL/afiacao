import { describe, it, expect } from 'vitest';
import { buildSessionPayload } from './build-session-payload';
import type { SpinAnalysis } from '@/lib/call/spin/types';
import type { TranscriptTurn } from '@/lib/transcription/types';

const fakeAnalysis = (overrides: Partial<SpinAnalysis> = {}): SpinAnalysis => ({
  spinStage: 'situation',
  confidence: 0.7,
  playbook: 'discovery',
  whatClientRevealed: { situationFacts: [], problemsAdmitted: [], implications: [], desiredOutcomes: [] },
  nextBestAction: { type: 'question', spinType: 'situation', exactPhrasing: '', whyNow: '' },
  ticketLeverage: { tactic: 'none', suggestion: '' },
  risks: [],
  crossSellTriggers: [],
  entitiesExtracted: [],
  ...overrides,
});

const fakeTurn = (overrides: Partial<TranscriptTurn> = {}): TranscriptTurn => ({
  id: 't1',
  speaker: 'cliente',
  text: 'oi',
  isFinal: true,
  startedAt: 1000,
  endedAt: 2000,
  ...overrides,
});

describe('buildSessionPayload', () => {
  it('mapeia campos obrigatórios', () => {
    const payload = buildSessionPayload({
      farmerId: 'farmer-1',
      customerUserId: 'cliente-1',
      phoneDialed: '31999991234',
      callBackend: 'webrtc',
      startedAt: new Date('2026-05-17T10:00:00Z'),
      endedAt: new Date('2026-05-17T10:18:00Z'),
      turns: [fakeTurn()],
      analyses: [fakeAnalysis()],
    });

    expect(payload.farmer_id).toBe('farmer-1');
    expect(payload.customer_user_id).toBe('cliente-1');
    expect(payload.phone_dialed).toBe('31999991234');
    expect(payload.call_backend).toBe('webrtc');
    expect(payload.duration_seconds).toBe(1080); // 18min = 1080s
    expect(payload.call_type).toBe('venda'); // default no schema
    expect(payload.call_result).toBe('atendeu'); // default — vendedor edita depois
  });

  it('serializa turns como TranscriptTurnLite (sem id, sem endedAt)', () => {
    const payload = buildSessionPayload({
      farmerId: 'farmer-1',
      customerUserId: null,
      phoneDialed: '31999991234',
      callBackend: 'webrtc',
      startedAt: new Date(0),
      endedAt: new Date(1000),
      turns: [fakeTurn({ id: 'should-be-stripped', endedAt: 999 })],
      analyses: [],
    });

    const transcript = payload.transcript as Array<Record<string, unknown>>;
    expect(transcript[0]).toEqual({
      speaker: 'cliente',
      text: 'oi',
      isFinal: true,
      startedAt: 1000,
    });
    expect(transcript[0]).not.toHaveProperty('id');
    expect(transcript[0]).not.toHaveProperty('endedAt');
  });

  it('agrega entities das múltiplas análises', () => {
    const payload = buildSessionPayload({
      farmerId: 'farmer-1',
      customerUserId: null,
      phoneDialed: '',
      callBackend: 'webrtc',
      startedAt: new Date(0),
      endedAt: new Date(0),
      turns: [],
      analyses: [
        fakeAnalysis({ entitiesExtracted: [{ type: 'competitor', value: 'Farben', context: '', confidence: 0.7 }] }),
        fakeAnalysis({ entitiesExtracted: [{ type: 'competitor', value: 'farben', context: '', confidence: 0.9 }] }),
      ],
    });

    const entities = payload.entities_extracted as Array<Record<string, unknown>>;
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ type: 'competitor', value: 'Farben', occurrences: 2, confidence: 0.9 });
  });

  it('chamada sem analyses gera analyses=[] e entities=[]', () => {
    const payload = buildSessionPayload({
      farmerId: 'farmer-1',
      customerUserId: null,
      phoneDialed: '',
      callBackend: 'webrtc',
      startedAt: new Date(0),
      endedAt: new Date(0),
      turns: [],
      analyses: [],
    });

    expect(payload.analyses).toEqual([]);
    expect(payload.entities_extracted).toEqual([]);
  });

  it('duration_seconds=0 quando ended_at <= started_at', () => {
    const payload = buildSessionPayload({
      farmerId: 'farmer-1',
      customerUserId: null,
      phoneDialed: '',
      callBackend: 'webrtc',
      startedAt: new Date(1000),
      endedAt: new Date(500),
      turns: [],
      analyses: [],
    });

    expect(payload.duration_seconds).toBe(0);
  });

  it('inclui atendimento_id quando fornecido (e null quando ausente)', () => {
    const base = { farmerId:'f1', customerUserId:'c1', phoneDialed:'5531999999999',
      callBackend:'webrtc' as const, startedAt:new Date('2026-06-13T10:00:00Z'),
      endedAt:new Date('2026-06-13T10:05:00Z'), turns:[], analyses:[] };
    expect(buildSessionPayload({ ...base, atendimentoId:'atend-1' }).atendimento_id).toBe('atend-1');
    expect(buildSessionPayload(base).atendimento_id).toBeNull();
  });
});
