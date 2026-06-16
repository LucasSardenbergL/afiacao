// src/lib/call-log/recording-policy.ts
import { resolveCustomerByPhone } from '@/lib/call-session/resolve-customer';
import type { CallPartyKind, MatchConfidence } from '@/types/call-log';

/** Auto-grava (e toca a Sara) quando é cliente OU fornecedor cadastrado. */
export function shouldAutoRecord(kind: CallPartyKind): boolean {
  return kind === 'cliente' || kind === 'fornecedor';
}

export interface ResolvedCallParty {
  kind: CallPartyKind;
  customerUserId: string | null;
  contactName?: string;
  contactCargo?: string;
  matchConfidence: MatchConfidence;
  phoneNormalized: string;
}

/**
 * Resolve quem é o número. Hoje cobre CLIENTE (customer_contacts/profiles).
 * Fornecedor é dormente: não há telefone de fornecedor no banco — quando existir,
 * adicionar a fonte aqui e devolver kind='fornecedor'. shouldAutoRecord já trata os dois.
 */
export async function resolveCallParty(rawPhone: string): Promise<ResolvedCallParty> {
  const r = await resolveCustomerByPhone(rawPhone);
  if (r.customerUserId) {
    return {
      kind: 'cliente',
      customerUserId: r.customerUserId,
      contactName: r.contactName,
      contactCargo: r.contactCargo,
      matchConfidence: 'last8',
      phoneNormalized: r.phoneDialed,
    };
  }
  return { kind: 'desconhecido', customerUserId: null, matchConfidence: 'none', phoneNormalized: r.phoneDialed };
}
