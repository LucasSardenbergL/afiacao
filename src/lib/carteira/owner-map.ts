// src/lib/carteira/owner-map.ts
// MIRROR-START owner-map — espelhado verbatim no edge ai-ops-agent (P0-B-bis ponta 3). Manter idêntico.
export interface AssignmentRow { customer_user_id: string; owner_user_id: string; }

// customer_user_id -> owner_user_id (dono da carteira). Fonte de verdade do farmer/score (Opcao A).
export function buildOwnerMap(assignments: AssignmentRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of assignments) m.set(a.customer_user_id, a.owner_user_id);
  return m;
}

// Resolve o dono de um cliente; fallback (ex.: Hunter/null) so se o cliente nao estiver na carteira.
export function resolveOwner(map: Map<string, string>, customerUserId: string, fallback: string | null): string | null {
  return map.get(customerUserId) ?? fallback;
}
// MIRROR-END
