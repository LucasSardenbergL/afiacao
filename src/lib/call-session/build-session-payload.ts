import type { SpinAnalysis } from '@/lib/call/spin/types';
import type { TranscriptTurn } from '@/lib/transcription/types';
import { aggregateEntities } from './aggregate-entities';

export interface BuildSessionPayloadInput {
  farmerId: string;
  customerUserId: string | null;
  phoneDialed: string;
  callBackend: 'webrtc' | 'nvoip' | 'manual';
  startedAt: Date;
  endedAt: Date;
  turns: TranscriptTurn[];
  analyses: SpinAnalysis[];
  /** Reverse-link ligação ↔ pedidos (best-effort). Mesmo uuid de sales_orders.atendimento_id. */
  atendimentoId?: string | null;
}

/** Subset de Insert<farmer_calls> que este helper preenche */
export interface SessionPayload {
  farmer_id: string;
  customer_user_id: string | null;
  phone_dialed: string;
  call_backend: 'webrtc' | 'nvoip' | 'manual';
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  transcript: unknown;          // jsonb
  analyses: unknown;            // jsonb
  entities_extracted: unknown;  // jsonb
  // defaults pra campos que vendedor edita depois
  call_type: string;
  call_result: string;
  /** Reverse-link ligação ↔ pedidos (best-effort). Mesmo uuid de sales_orders.atendimento_id. */
  atendimento_id: string | null;
}

/**
 * Monta o payload pronto pra `supabase.from('farmer_calls').insert(payload)`.
 * Defaults conservadores em call_type e call_result — vendedor edita pelo form.
 */
export function buildSessionPayload(input: BuildSessionPayloadInput): SessionPayload {
  const durationMs = input.endedAt.getTime() - input.startedAt.getTime();
  const durationSeconds = durationMs > 0 ? Math.round(durationMs / 1000) : 0;

  // TranscriptTurn → TranscriptTurnLite (sem id/endedAt — fica jsonb mais leve)
  const transcriptLite = input.turns.map((t) => ({
    speaker: t.speaker,
    text: t.text,
    isFinal: t.isFinal,
    startedAt: t.startedAt,
  }));

  const entities = aggregateEntities(input.analyses);

  return {
    farmer_id: input.farmerId,
    customer_user_id: input.customerUserId,
    phone_dialed: input.phoneDialed,
    call_backend: input.callBackend,
    started_at: input.startedAt.toISOString(),
    ended_at: input.endedAt.toISOString(),
    duration_seconds: durationSeconds,
    transcript: transcriptLite,
    analyses: input.analyses,
    entities_extracted: entities,
    // Defaults — vendedor edita depois no form
    call_type: 'venda',
    call_result: 'atendeu',
    atendimento_id: input.atendimentoId ?? null,
  };
}
