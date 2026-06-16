// src/lib/carteira/owner-map.ts
export interface AssignmentRow { customer_user_id: string; owner_user_id: string; }

/** customer_user_id → owner_user_id (dono da carteira). Fonte de verdade do score (Opção A). */
export function buildOwnerMap(assignments: AssignmentRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of assignments) m.set(a.customer_user_id, a.owner_user_id);
  return m;
}

/** Resolve o dono de um cliente; fallback (ex.: Hunter) só se o cliente não estiver na carteira. */
export function resolveOwner(map: Map<string, string>, customerUserId: string, fallback: string | null): string | null {
  return map.get(customerUserId) ?? fallback;
}
