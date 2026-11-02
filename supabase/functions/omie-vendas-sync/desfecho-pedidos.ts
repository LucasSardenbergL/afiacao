// DESFECHO do `sync_pedidos` no modo INCREMENTAL (cron 2h, janela today-5..today, sem cursor).
//
// Defeito que isto fecha: no incremental, rate-limit/transitório do Omie que ESGOTA os retries
// faz o loop de `syncPedidos` PAUSAR (`complete=false`, `lastErrorKind` preenchido) — certo no
// backfill, onde o cursor retoma do `nextPage`. Mas o incremental não tem cursor: a action
// respondia `{ success: true, ... }` com HTTP 200 e o `fin_sync_log` gravava 'complete'. Os
// pedidos das páginas não lidas ficavam fora do banco SEM sinal nenhum (prod: fin_sync_log
// 81346900-f8ca-459d-8e83-148f804f03c0, colacor 2026-10-13 20:20 — transitório na pág 1,
// 0 pedidos gravados, status 'complete').
//
// Agora: incremental que não chegou ao FIM REAL do Omie (transitório, página anômala ou
// orçamento de páginas esgotado) NÃO é sucesso — HTTP 500 + `success: false` e o log vira
// 'error' com os contadores (o watchdog e o data_health enxergam). Mesma forma do N2 do
// catálogo (./catalogo-gravacao.ts). O caminho feliz é byte-idêntico: `{ success: true, ...r }`.
//
// Separado do index.ts para ser testável no Deno sem o resto da edge (desfecho-pedidos_test.ts).

/** Marca ASCII estável do ramo de falha — o teste e o operador casam por ela. */
export const MARCA_PEDIDOS_INCOMPLETO = "SYNC_PEDIDOS_INCOMPLETO";

/** O subconjunto do retorno de `syncPedidos` que decide o desfecho. */
export interface ResultadoSyncPedidosIncremental {
  complete: boolean;
  lastErrorKind: "rate_limit" | "transient" | "http" | null;
  lastPage: number;
  nextPage: number | null;
  totalSynced: number;
  [campo: string]: unknown;
}

export type DesfechoSyncPedidos =
  | { ok: true; status: 200; corpo: Record<string, unknown> }
  | { ok: false; status: 500; erro: string; corpo: Record<string, unknown> };

function motivoDaParada(r: ResultadoSyncPedidosIncremental): string {
  // Sem lastErrorKind e sem fim real = o `while (pagesProcessed < maxPages)` acabou o orçamento.
  return r.lastErrorKind ?? "orcamento_de_paginas";
}

export function desfechoSyncPedidosIncremental(r: ResultadoSyncPedidosIncremental): DesfechoSyncPedidos {
  if (r.complete) return { ok: true, status: 200, corpo: { success: true, ...r } };
  const erro = `${MARCA_PEDIDOS_INCOMPLETO}: janela incremental parou na pagina ${r.nextPage ?? "?"} `
    + `sem chegar ao fim real do Omie (motivo: ${motivoDaParada(r)}); ${r.totalSynced} pedido(s) gravado(s) `
    + `antes da parada, os das paginas seguintes NAO foram importados nesta run`;
  return { ok: false, status: 500, erro, corpo: { success: false, error: erro, ...r } };
}

/**
 * Fronteira da action: incompleto FINALIZA o log como erro (`finalizarLog` → `fin_sync_log.status
 * ='error'`) antes de devolver o 500, para o epílogo da edge não fechá-lo como 'complete'.
 * Completo não finaliza: o epílogo comum das actions de sync fecha.
 */
export async function concluirSyncPedidosIncremental(
  r: ResultadoSyncPedidosIncremental,
  finalizarLog: (corpo: Record<string, unknown>, erro: string) => Promise<void>,
): Promise<{ status: 200 | 500; corpo: Record<string, unknown> }> {
  const desfecho = desfechoSyncPedidosIncremental(r);
  if (!desfecho.ok) await finalizarLog(desfecho.corpo, desfecho.erro);
  return { status: desfecho.status, corpo: desfecho.corpo };
}
