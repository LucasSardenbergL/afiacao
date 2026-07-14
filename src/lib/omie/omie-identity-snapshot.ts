// MIRROR-START omie identity-snapshot-parse — espelhado verbatim nos edges omie-vendas-sync e omie-analytics-sync
// Valida o CONTRATO JSON da RPC omie_sync_identity_snapshot e constrói os mapas. FAIL-CLOSED (Codex
// challenge PR-1): supabase-js .rpc() resolve {error} — error=null só prova HTTP/SQL bem-sucedido, NÃO o
// contrato. Uma RPC revertida/malformada pode devolver HTTP 200 com {doc_to_user:null,...}; o `?? {}` a
// degradaria para Map(0) SILENCIOSO (vendas pula pedidos, analytics não vincula) sem SQLSTATE. Aqui shape
// inválido (null/array/tipo errado/valor não-UUID/doc ambíguo vazado em doc_to_user) LANÇA — precisão>recall.
const OMIE_SNAPSHOT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseIdentitySnapshot(
  snap: unknown,
): { docToUserMap: Map<string, string>; ambiguousDocs: Set<string>; clientToUserMap: Map<string, string> } {
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
    throw new Error("identity snapshot: resposta não é objeto (fail-closed)");
  }
  const s = snap as Record<string, unknown>;
  const d2u = s.doc_to_user;
  const amb = s.ambiguous_docs;
  if (!d2u || typeof d2u !== "object" || Array.isArray(d2u)) {
    throw new Error("identity snapshot: doc_to_user ausente ou não-objeto (fail-closed)");
  }
  if (!Array.isArray(amb)) {
    throw new Error("identity snapshot: ambiguous_docs ausente ou não-array (fail-closed)");
  }
  const ambiguousDocs = new Set<string>();
  for (const doc of amb) {
    if (typeof doc !== "string") throw new Error("identity snapshot: ambiguous_docs com item não-string (fail-closed)");
    ambiguousDocs.add(doc);
  }
  const docToUserMap = new Map<string, string>();
  for (const [doc, user] of Object.entries(d2u)) {
    if (typeof user !== "string" || !OMIE_SNAPSHOT_UUID_RE.test(user)) {
      throw new Error("identity snapshot: user_id não-UUID em doc_to_user (fail-closed)");
    }
    // disjunção: um doc não pode estar em doc_to_user E em ambiguous_docs (seria fail-open da RPC)
    if (ambiguousDocs.has(doc)) {
      throw new Error("identity snapshot: doc presente em doc_to_user E ambiguous_docs — fail-open da RPC (fail-closed)");
    }
    docToUserMap.set(doc, user);
  }
  // PR-2/A2: client_to_user (código Omie → user, prova positiva por documento no MESMO snapshot atômico).
  // Validado por ÚLTIMO — os casos inválidos de doc_to_user/ambiguous_docs lançam antes, pelo motivo próprio.
  // Mesmo rigor fail-closed: shape inválido (ausente/não-objeto/valor não-UUID) LANÇA, não degrada p/ Map(0).
  const c2u = s.client_to_user;
  if (!c2u || typeof c2u !== "object" || Array.isArray(c2u)) {
    throw new Error("identity snapshot: client_to_user ausente ou não-objeto (fail-closed)");
  }
  const clientToUserMap = new Map<string, string>();
  for (const [codigo, user] of Object.entries(c2u)) {
    if (typeof user !== "string" || !OMIE_SNAPSHOT_UUID_RE.test(user)) {
      throw new Error("identity snapshot: user_id não-UUID em client_to_user (fail-closed)");
    }
    clientToUserMap.set(codigo, user);
  }
  return { docToUserMap, ambiguousDocs, clientToUserMap };
}
// MIRROR-END
