// MIRROR-START omie-sync-identidade — espelhado verbatim em supabase/functions/omie-sync/index.ts
// Decisão de identidade Omie do PEDIDO SELF-SERVICE (conta colacor_sc) — money-path P0-B-bis. PURA:
// recebe a linha da VIEW FRESCA account-correta (omie_customer_account_map_fresco) já buscada + os
// matches da API Omie (registros_por_pagina:2) e decide o código autoritativo OU fail-closed.
// Precisão>recall: doc-ambíguo (2+ códigos distintos), ausência confirmada, ou código bigint não
// representável = REJECT. NÃO lê o espelho poluído omie_clientes. A âncora (user_id, account) e o I/O
// (buscar a view, buscar a API, write-back) ficam no chamador; aqui só a decisão. Espelhado no edge
// (Deno não importa de src/); paridade textual no CI em src/__tests__/edge-money-path-invariants.test.ts.
export interface MatchOmie { codigo_cliente: number; codigo_vendedor: number | null }
export type IdentidadeSelfService =
  | { ok: true; codigo_cliente: number; codigo_vendedor: number | null }
  | { ok: false; needOmie: true }
  | { ok: false; erro: 'doc-ambíguo' | 'sem-vinculo' | 'codigo-inseguro' };

export function decidirIdentidadeSelfService(args: {
  viewRow: MatchOmie | null;
  omieMatches: MatchOmie[] | null;
}): IdentidadeSelfService {
  const { viewRow, omieMatches } = args;

  let cand: MatchOmie;
  if (viewRow) {
    // View fresca já é account-correta (1 linha por (user_id, account)) — resolve sem API.
    cand = viewRow;
  } else {
    // Ausência na view → o chamador precisa buscar a API Omie por documento.
    if (omieMatches === null) return { ok: false, needOmie: true };
    // Dedup por código: 2+ códigos DISTINTOS no mesmo doc = ambíguo — chutar o 1º seria last-write-wins.
    const distintos = [...new Map(omieMatches.map((m) => [String(m.codigo_cliente), m])).values()];
    if (distintos.length > 1) return { ok: false, erro: 'doc-ambíguo' };
    if (distintos.length === 0) return { ok: false, erro: 'sem-vinculo' };
    cand = distintos[0];
  }

  // Segurança de representação (bigint): códigos Omie são bigint; Number perde precisão ≥ 2^53. Um código
  // truncado mandaria o pedido pro cliente errado — fail-closed em vez de arriscar (espelha o guard do
  // decideAccountIdentity). Vendedor é secundário (não é âncora de identidade) → passa como veio.
  if (!Number.isSafeInteger(cand.codigo_cliente) || cand.codigo_cliente <= 0) {
    return { ok: false, erro: 'codigo-inseguro' };
  }
  return { ok: true, codigo_cliente: cand.codigo_cliente, codigo_vendedor: cand.codigo_vendedor };
}
// MIRROR-END
