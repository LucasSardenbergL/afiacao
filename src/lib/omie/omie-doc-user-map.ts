// MIRROR-START omie doc-user-fail-closed — espelhado verbatim em supabase/functions/omie-vendas-sync/index.ts
// P1 (fail-closed money-path): no syncPedidos, o docToUserMap (doc normalizado -> user_id de profiles)
// alimenta o fallback resolveClientUserId (ConsultarCliente devolve o doc -> docToUserMap.get(doc)). Se 2
// profiles DISTINTOS compartilham o mesmo CPF/CNPJ, o last-write-wins gravava o user do ÚLTIMO da paginação
// e o pedido money-path era atribuído ao cliente ARBITRÁRIO. Fail-closed: doc com 2+ users distintos fica
// FORA do mapa (precisão > recall — melhor cair no skip/log que atribuir errado). Análogo VENDAS do lado
// profile (fetchProfileDocUserMap, P1b). Espelhado no edge (Deno não importa de src/); paridade textual no
// CI em src/__tests__/edge-money-path-invariants.test.ts.
export function buildDocUserMapFailClosed(
  registros: ReadonlyArray<{ doc: string; userId: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  const ambiguos = new Set<string>();
  for (const r of registros) {
    if (!r.doc || !r.userId) continue;         // sem doc ou sem user → não vira vínculo
    if (ambiguos.has(r.doc)) continue;          // já ambíguo → permanece FORA (sticky)
    const prev = map.get(r.doc);
    if (prev === undefined) { map.set(r.doc, r.userId); continue; }
    if (prev === r.userId) continue;            // mesmo user repetido (duplicata de paginação, idempotente)
    map.delete(r.doc);                          // 2º user DISTINTO → ambíguo, fail-closed
    ambiguos.add(r.doc);
  }
  return map;
}
// MIRROR-END
