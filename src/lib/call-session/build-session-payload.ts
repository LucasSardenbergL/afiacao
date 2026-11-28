import type { SpinAnalysis } from '@/lib/call/spin/types';
import type { TranscriptTurn } from '@/lib/transcription/types';
import type { Database, Json } from '@/integrations/supabase/types';
import { aggregateEntities } from './aggregate-entities';

type FarmerCallType = Database['public']['Enums']['farmer_call_type'];
type FarmerCallResult = Database['public']['Enums']['farmer_call_result'];

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
  transcript: Json;
  analyses: Json;
  entities_extracted: Json;
  // defaults pra campos que vendedor edita depois — tipados pelo ENUM do banco: com `string`
  // o payload aceitou 'venda'/'atendeu', o Postgres recusou todo insert e farmer_calls ficou com 0 linhas.
  call_type: FarmerCallType;
  call_result: FarmerCallResult;
  /** Reverse-link ligação ↔ pedidos (best-effort). Mesmo uuid de sales_orders.atendimento_id. */
  atendimento_id: string | null;
}

/**
 * Monta o payload pronto pra `supabase.from('farmer_calls').insert(payload)`.
 * Defaults de conversa em call_type/call_result (valores do enum) — vendedor edita depois.
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
    // Interfaces TS não têm index signature, então não casam com `Json` mesmo sendo JSON puro.
    // O cast fica nos 2 campos jsonb — call_type/call_result seguem checados contra o enum.
    analyses: input.analyses as unknown as Json,
    entities_extracted: entities as unknown as Json,
    // Defaults de CONVERSA (design 6.1: farmer_calls só nasce de ligação conectada e com conteúdo).
    // O card de fim (fase 2, item 10) sobrescreve o resultado.
    call_type: 'follow_up',
    call_result: 'contato_sucesso',
    atendimento_id: input.atendimentoId ?? null,
  };
}
