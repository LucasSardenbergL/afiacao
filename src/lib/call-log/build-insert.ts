// src/lib/call-log/build-insert.ts
import { normalizeBrPhone } from '@/lib/phone';
import type { CallDirection, CallProvider } from '@/types/call-log';
import type { ResolvedCallParty } from './recording-policy';

export interface BuildInsertArgs {
  farmerId: string;
  direction: CallDirection;
  provider: CallProvider;
  phoneRaw: string;
  party: ResolvedCallParty;
  recorded: boolean;
  callerIdUsed?: string | null;
  sipCallId?: string | null;
  providerCallId?: string | null;
}

/** Monta o objeto de insert da call_log no estado inicial 'ringing'. */
export function buildCallLogInsert(args: BuildInsertArgs) {
  return {
    farmer_id: args.farmerId,
    direction: args.direction,
    status: 'ringing' as const,
    provider: args.provider,
    provider_call_id: args.providerCallId ?? null,
    sip_call_id: args.sipCallId ?? null,
    customer_user_id: args.party.customerUserId,
    match_confidence: args.party.matchConfidence,
    display_name: args.party.contactName ?? null,
    phone_normalized: args.party.phoneNormalized || normalizeBrPhone(args.phoneRaw),
    phone_raw: args.phoneRaw,
    caller_id_used: args.callerIdUsed ?? null,
    recorded: args.recorded,
    source: 'app' as const,
  };
}
