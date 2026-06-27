// Helper PURO da janela de previsão do sync de pedidos de compra
// (PesquisarPedCompra → purchase_orders_tracking).
//
// Espelhado VERBATIM (byte-idêntico) em supabase/functions/_shared/janela-pedidos-compra.ts —
// o Deno do edge não importa de src/. Paridade provada em __tests__/janela-pedidos-compra.parity.test.ts.
//
// CONTEXTO money-path: o filtro dDataInicial/dDataFinal do PesquisarPedCompra é por DATA DE PREVISÃO DE
// ENTREGA (dDtPrevisao), NÃO por criação (#1072). O FUTURO (+120d) cobre "pedido a caminho" (entrega futura
// dentro do lead time) e NUNCA pode encolher — encolher o futuro reintroduz o #1072 (o tracking some o
// pedido a caminho). O PASSADO pode variar por MODO: o cron roda INCREMENTAL (passado curto) na maioria das
// rodadas (a cada 2h) e COMPLETO (passado amplo, reconcilia pedidos atrasados) ~1×/dia; manual/backfill é
// sempre completo. Ver docs/agent/reposicao.md (§ "Duas edges varrem...") e sync.md.

export type ModoSyncPedidos = "incremental" | "completo";

export const JANELA_FUTURO_DIAS = 120; // FIXO — guard contra #1072 (previsão futura = a caminho). NÃO varia com modo/dias.
export const JANELA_PASSADO_COMPLETO_DIAS = 365; // piso do modo completo (previsão atrasada não-recebida)
export const JANELA_PASSADO_INCREMENTAL_DIAS = 60; // modo incremental (cron frequente): só o passado recente
export const JANELA_PASSADO_MAX_DIAS = 1095; // teto do override `dias` (backfill manual) — 3 anos
export const FULL_SYNC_MAX_IDADE_H = 20; // sem um completo bem-sucedido há mais que isto → o cron força completo

/**
 * Calcula a janela de PREVISÃO [passadoDias, futuroDias] do PesquisarPedCompra para um modo.
 * - futuroDias é SEMPRE JANELA_FUTURO_DIAS (invariante money-path — nunca depende de modo/dias).
 * - incremental: passado fixo curto (ignora `dias`).
 * - completo: piso JANELA_PASSADO_COMPLETO_DIAS; `dias` só AMPLIA (backfill), com clamp ao teto. Nunca encolhe.
 */
export function computeJanelaPrevisao(
  modo: ModoSyncPedidos,
  dias?: number,
): { passadoDias: number; futuroDias: number } {
  const futuroDias = JANELA_FUTURO_DIAS;
  if (modo === "incremental") {
    return { passadoDias: JANELA_PASSADO_INCREMENTAL_DIAS, futuroDias };
  }
  const base = Number.isFinite(dias) ? (dias as number) : 0;
  const passadoDias = Math.min(
    JANELA_PASSADO_MAX_DIAS,
    Math.max(JANELA_PASSADO_COMPLETO_DIAS, base),
  );
  return { passadoDias, futuroDias };
}

/**
 * Decide se o ciclo do cron deve rodar COMPLETO (reconciliação ampla) em vez de incremental.
 * Robusto a mudança de schedule (NÃO depende da hora do relógio): completo quando nunca houve um completo
 * bem-sucedido, ou o último é mais velho que maxIdadeH. `lastFullAtMs` = epoch ms do último completo
 * (de sync_state.metadata.last_full_at), ou null se nunca houve.
 */
export function deveRodarCompleto(
  lastFullAtMs: number | null,
  nowMs: number,
  maxIdadeH: number = FULL_SYNC_MAX_IDADE_H,
): boolean {
  if (lastFullAtMs === null) return true;
  return nowMs - lastFullAtMs > maxIdadeH * 3600_000;
}
