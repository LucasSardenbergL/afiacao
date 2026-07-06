// MIRROR-START omie derive-account-identity — espelhado verbatim em supabase/functions/omie-vendas-sync/index.ts
// Decisão de identidade Omie por conta (money-path P0-B). PURA: recebe dados já buscados (espelho local
// + matches da API Omie) e decide o código autoritativo OU fail-closed. Precisão>recall: ambiguidade,
// ausência confirmada, divergência com o código do payload, ou código não-representável = REJECT.
// A âncora (documento) e o I/O (buscar espelho/Omie, backfill) ficam no chamador; aqui só a decisão.
export interface MirrorRow { omie_codigo_cliente: number; omie_codigo_vendedor: number | null; empresa_omie: string }
export interface OmieMatch { codigo_cliente: number; codigo_vendedor: number | null }
export interface DecideInput {
  account: string;
  /** Código que o cliente mandou no payload — ADVISORY (verificado contra o derivado). */
  suppliedCodigo: number | null;
  /** Linhas de omie_clientes dos users do documento (qualquer empresa). */
  mirrorRows: ReadonlyArray<MirrorRow>;
  /** buscarClienteVendas(registros_por_pagina:2) na conta; null = o chamador ainda não buscou. */
  omieMatches: ReadonlyArray<OmieMatch> | null;
}
export type DecideResult =
  | { ok: true; source: 'mirror' | 'omie'; codigo_cliente: number; codigo_vendedor: number | null; backfill: boolean }
  | { ok: false; needOmie: true }
  | { ok: false; reason: 'ambiguous_mirror' | 'ambiguous_omie' | 'absent' | 'divergence' | 'unsafe_integer' };

// bigint-safe: compara como string decimal canônica (códigos Omie são bigint; Number perde precisão ≥ 2^53).
const sameCode = (a: number, b: number): boolean => String(a) === String(b);

export function decideAccountIdentity(input: DecideInput): DecideResult {
  const { account, suppliedCodigo, mirrorRows, omieMatches } = input;

  // 1. Espelho, restrito à conta alvo (linhas de OUTRA conta são ignoradas — não acusam nem servem).
  const naConta = mirrorRows.filter((r) => r.empresa_omie === account);
  const distintos = [...new Map(naConta.map((r) => [String(r.omie_codigo_cliente), r])).values()];

  let cand: { codigo_cliente: number; codigo_vendedor: number | null; source: 'mirror' | 'omie'; backfill: boolean };

  if (distintos.length === 1) {
    cand = { codigo_cliente: distintos[0].omie_codigo_cliente, codigo_vendedor: distintos[0].omie_codigo_vendedor, source: 'mirror', backfill: false };
  } else if (distintos.length > 1) {
    return { ok: false, reason: 'ambiguous_mirror' };
  } else {
    // 0 no espelho → precisa da API Omie
    if (omieMatches === null) return { ok: false, needOmie: true };
    if (omieMatches.length > 1) return { ok: false, reason: 'ambiguous_omie' }; // duplicata-CNPJ — não chuta
    if (omieMatches.length === 0) return { ok: false, reason: 'absent' };
    cand = { codigo_cliente: omieMatches[0].codigo_cliente, codigo_vendedor: omieMatches[0].codigo_vendedor, source: 'omie', backfill: true };
  }

  // 2. Segurança de representação (bigint): código fora do range seguro não vai pro Omie.
  if (!Number.isSafeInteger(cand.codigo_cliente) || cand.codigo_cliente <= 0) return { ok: false, reason: 'unsafe_integer' };

  // 3. Divergência: o código do payload é advisory; se contradiz o derivado, fail-closed (não override).
  if (suppliedCodigo != null && !sameCode(suppliedCodigo, cand.codigo_cliente)) return { ok: false, reason: 'divergence' };

  return { ok: true, source: cand.source, codigo_cliente: cand.codigo_cliente, codigo_vendedor: cand.codigo_vendedor, backfill: cand.backfill };
}
// MIRROR-END
