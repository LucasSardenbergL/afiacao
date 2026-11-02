// Roda o CÓDIGO REAL de desfecho-pedidos.ts (sync_pedidos incremental incompleto não vira sucesso).
import {
  concluirSyncPedidosIncremental,
  desfechoSyncPedidosIncremental,
  MARCA_PEDIDOS_INCOMPLETO,
  type ResultadoSyncPedidosIncremental,
} from "./desfecho-pedidos.ts";

// Asserções locais em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
function assert(cond: boolean, msg = "assert falhou"): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}
function assertStrictEquals(a: unknown, b: unknown) {
  if (a !== b) throw new Error(`assertStrictEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

function resultado(over: Partial<ResultadoSyncPedidosIncremental>): ResultadoSyncPedidosIncremental {
  return {
    leasePerdido: false, totalSynced: 0, totalItems: 0, totalPaginas: 1,
    lastPage: 0, nextPage: null, complete: true, lastErrorKind: null, ...over,
  };
}

function logFake() {
  const chamadas: Array<{ corpo: Record<string, unknown>; erro: string }> = [];
  return { chamadas, finalizar: (corpo: Record<string, unknown>, erro: string) => { chamadas.push({ corpo, erro }); return Promise.resolve(); } };
}

Deno.test("completo (fim real): 200 com o corpo de sempre e o log NÃO é finalizado aqui", async () => {
  const r = resultado({ totalSynced: 37, lastPage: 2, totalPaginas: 2 });
  const log = logFake();
  const saida = await concluirSyncPedidosIncremental(r, log.finalizar);
  assertStrictEquals(saida.status, 200);
  assertEquals(saida.corpo, { success: true, ...r });
  assertStrictEquals(log.chamadas.length, 0);
});

// O caso de prod: fin_sync_log 81346900-f8ca-459d-8e83-148f804f03c0 (colacor, 2026-10-13 20:20).
Deno.test("transitório esgotado na pág 1: 500, success:false e o log vira erro com a marca", async () => {
  const r = resultado({ complete: false, lastErrorKind: "transient", lastPage: 0, nextPage: 1 });
  const log = logFake();
  const saida = await concluirSyncPedidosIncremental(r, log.finalizar);
  assertStrictEquals(saida.status, 500);
  assertStrictEquals(saida.corpo.success, false);
  assertStrictEquals(saida.corpo.complete, false);
  assertStrictEquals(log.chamadas.length, 1);
  assertStrictEquals(log.chamadas[0].corpo, saida.corpo);
  assert(log.chamadas[0].erro.startsWith(`${MARCA_PEDIDOS_INCOMPLETO}: janela incremental parou na pagina 1 `));
  assert(log.chamadas[0].erro.includes("(motivo: transient); 0 pedido(s) gravado(s)"));
  assertStrictEquals(saida.corpo.error, log.chamadas[0].erro);
});

Deno.test("rate-limit e página anômala também NÃO são sucesso (motivo no texto)", () => {
  for (const kind of ["rate_limit", "http"] as const) {
    const d = desfechoSyncPedidosIncremental(resultado({ complete: false, lastErrorKind: kind, nextPage: 3, totalSynced: 100 }));
    assert(!d.ok, `${kind} virou sucesso`);
    assertStrictEquals(d.status, 500);
    assert(d.erro.includes(`(motivo: ${kind}); 100 pedido(s)`), d.erro);
  }
});

Deno.test("orçamento de páginas esgotado (sem lastErrorKind, sem fim real): 500 com motivo próprio", () => {
  const d = desfechoSyncPedidosIncremental(resultado({ complete: false, lastErrorKind: null, lastPage: 10, nextPage: 11 }));
  assert(!d.ok, "orçamento esgotado virou sucesso");
  assert(d.erro.includes("parou na pagina 11 sem chegar ao fim real do Omie (motivo: orcamento_de_paginas)"), d.erro);
});

// ── Costura no index.ts ───────────────────────────────────────────────────────────────────────
// O handler não é importável no Deno (Deno.serve + supabase-js remoto com `--no-remote`): a ligação
// helper↔handler é conferida no TEXTO. Voltar ao `result = { success: true, ...syncPedidosResult }`
// devolveria 200/'complete' com páginas não lidas sem nenhum teste do helper perceber.
const INDEX = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
const plano = (s: string) => s.replace(/\s+/g, " ");
function regiao(inicio: string, fim: string): string {
  const i = INDEX.indexOf(inicio);
  assert(i >= 0, `início não achado no index.ts: ${inicio}`);
  const j = INDEX.indexOf(fim, i + inicio.length);
  assert(j > i, `fim não achado no index.ts: ${fim}`);
  return plano(INDEX.slice(i, j));
}
function contem(trecho: string, esperado: string) {
  assert(trecho.includes(plano(esperado)), `costura ausente no index.ts: ${esperado}`);
}

Deno.test("costura: o incremental do sync_pedidos responde o status do desfecho e finaliza o log com o erro", () => {
  const r = regiao("// Modo INCREMENTAL (rolante, sem cursor)", 'case "reparar_orfaos_itens": {');
  contem(r, "const saidaPedidos = await concluirSyncPedidosIncremental(syncPedidosResult, async (corpo, erro) => {");
  contem(r, "await completeVendaSync(supabaseAdmin, vendaLogId, corpo, erro); vendaSyncFinalized = true;");
  contem(r, "if (saidaPedidos.status !== 200) { return new Response(JSON.stringify(saidaPedidos.corpo), { status: saidaPedidos.status,");
  contem(r, "result = saidaPedidos.corpo;");
  assert(!r.includes("success: true"), "o incremental voltou a afirmar success:true por conta própria");
});
