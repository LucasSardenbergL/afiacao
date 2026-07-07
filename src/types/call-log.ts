export type CallDirection = 'inbound' | 'outbound';
type CallStatus =
  | 'ringing' | 'answered' | 'missed' | 'rejected'
  | 'busy' | 'failed' | 'canceled' | 'ended';
export type CallProvider = 'nvoip_click_to_call' | 'nvoip_sip' | 'manual';
type CallSource = 'app' | 'cdr' | 'webhook' | 'backfill';
export type MatchConfidence = 'exact' | 'last8' | 'none';

/** Tipo da parte identificada pela BINA. 'fornecedor' é dormente (sem dado hoje). */
export type CallPartyKind = 'cliente' | 'fornecedor' | 'desconhecido';

export interface CallLogRow {
  id: string;
  farmer_id: string;
  direction: CallDirection;
  status: CallStatus;
  provider: CallProvider;
  provider_call_id: string | null;
  sip_call_id: string | null;
  customer_user_id: string | null;
  matched_contact_id: string | null;
  match_confidence: MatchConfidence | null;
  display_name: string | null;
  phone_normalized: string | null;
  phone_raw: string | null;
  caller_id_used: string | null;
  recorded: boolean;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number;
  acknowledged_at: string | null;
  source: CallSource;
  source_payload: unknown;
  last_synced_at: string | null;
  farmer_call_id: string | null;
  created_at: string;
}
