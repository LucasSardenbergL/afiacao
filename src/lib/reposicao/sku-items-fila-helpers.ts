// Helpers puros da fila do sync de leadtime por item de NFe (omie-sync-sku-items).
//
// Por que existem: a fila de NFes pendentes era "tudo que não tem linha em
// sku_leadtime_history", em ordem fixa t2 DESC. NFe cuja consulta Omie retorna
// 0 itens nunca upserta → nunca sai da fila → re-consultada a cada run (poison),
// consumindo o guard de 50s e deixando as antigas inalcançáveis (starvation) —
// incidente OBEN 2026-07-14. O controle de tentativas (sku_items_sync_controle)
// + backoff + ordenação nunca-tentadas-primeiro drenam a fila.
//
// ESPELHADOS verbatim na edge supabase/functions/omie-sync-sku-items/index.ts
// (bloco // MIRROR-START sku-items-fila) — o Deno da edge não importa de src/;
// a paridade é provada em src/__tests__/edge-money-path-invariants.test.ts.

// MIRROR-START sku-items-fila
export interface SkuItemsFilaControle {
  tentativas: number;
  ultima_tentativa: string | null;
}

/** Backoff entre re-tentativas de consulta por NFe: 1ª falha re-tenta em 6h,
 *  2ª em 24h, da 3ª em diante 72h. Tentativas <=0 = virgem (sempre elegível). */
export function skuItemsBackoffMs(tentativas: number): number {
  if (tentativas <= 0) return 0;
  if (tentativas === 1) return 6 * 3_600_000;
  if (tentativas === 2) return 24 * 3_600_000;
  return 72 * 3_600_000;
}

/** Elegível para consultar se nunca tentada, controle ilegível ou backoff vencido. */
export function skuItemsElegivel(
  controle: SkuItemsFilaControle | undefined,
  agoraMs: number,
): boolean {
  if (!controle || controle.tentativas <= 0 || !controle.ultima_tentativa) return true;
  const ultimaMs = Date.parse(controle.ultima_tentativa);
  if (!Number.isFinite(ultimaMs)) return true;
  return agoraMs - ultimaMs >= skuItemsBackoffMs(controle.tentativas);
}

/** Ordem da fila: nunca-tentadas primeiro (tentativas ASC); empate → faturamento
 *  mais ANTIGO primeiro. Poison (muitas tentativas) naturalmente vai pro fim.
 *
 *  O empate é earliest-deadline-first, não "mais recente primeiro": a NFe só é
 *  visível enquanto está dentro da janela de `dias` do run, então a mais antiga é
 *  a de menor folga — se o guard de 50s corta o run, quem fica de fora deve ser
 *  quem volta amanhã (folga grande), não quem expira sem nunca virar leadtime. */
export function skuItemsCompararFila(
  a: { tentativas: number; t2: string },
  b: { tentativas: number; t2: string },
): number {
  if (a.tentativas !== b.tentativas) return a.tentativas - b.tentativas;
  return a.t2 === b.t2 ? 0 : a.t2 < b.t2 ? -1 : 1;
}
// MIRROR-END
