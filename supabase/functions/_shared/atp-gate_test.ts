// Testa o CÓDIGO REAL de atp-gate.ts (classificação do retorno/erro da RPC
// atp_gate_pedido) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/atp-gate_test.ts

import { classificarErroAtpGate, classificarRetornoAtpGate } from "./atp-gate.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

Deno.test("retorno ok reservado → seguir", () => {
  const r = classificarRetornoAtpGate({ ok: true, resultado: "reservado", reservas: [] });
  assertEquals(r.acao, "seguir");
  assertEquals(r.resultado, "reservado");
  assertEquals(r.bloquearia, false);
});

Deno.test("retorno ok ja_enviado → seguir (retry idempotente)", () => {
  const r = classificarRetornoAtpGate({ ok: true, resultado: "ja_enviado" });
  assertEquals(r.acao, "seguir");
  assertEquals(r.resultado, "ja_enviado");
});

Deno.test("retorno advisory_bloqueado → seguir COM bloquearia (caller antigo não quebra)", () => {
  const r = classificarRetornoAtpGate({
    ok: true, resultado: "advisory_bloqueado", bloquearia: true,
    recusas: [{ omie_codigo_produto: 1, motivo: "saldo_insuficiente" }],
  });
  assertEquals(r.acao, "seguir");
  assertEquals(r.bloquearia, true);
  assertEquals(Array.isArray(r.recusas), true);
});

Deno.test("retorno ok:false blocked:atp com recusas → bloquear", () => {
  const r = classificarRetornoAtpGate({
    ok: false, blocked: "atp", resultado: "bloqueado",
    recusas: [{ omie_codigo_produto: 2002, motivo: "saldo_insuficiente", solicitado: 10, disponivel: 3 }],
  });
  assertEquals(r.acao, "bloquear");
  assertEquals((r.recusas as unknown[]).length, 1);
});

Deno.test("bloqueio SEM recusas é contrato quebrado → falha_verificacao (nunca fabricar recusa)", () => {
  const r = classificarRetornoAtpGate({ ok: false, blocked: "atp", recusas: [] });
  assertEquals(r.acao, "falha_verificacao");
});

Deno.test("shape fora do contrato → falha_verificacao (fail-closed, nunca seguir)", () => {
  for (const data of [null, undefined, 42, "ok", [], {}, { ok: "sim" }, { ok: false }]) {
    const r = classificarRetornoAtpGate(data);
    assertEquals(r.acao, "falha_verificacao", `data=${JSON.stringify(data)}`);
  }
});

Deno.test("erro 42501 (autorização) → falha SEM override (não vira contingência)", () => {
  const r = classificarErroAtpGate({ code: "42501", message: "backorder sem bloqueio previo" });
  assertEquals(r.acao, "falha_verificacao");
  assertEquals(r.semOverride, true);
});

Deno.test("erro 22023 (contrato/dado) → falha SEM override", () => {
  const r = classificarErroAtpGate({ code: "22023", message: "item invalido" });
  assertEquals(r.semOverride, true);
});

Deno.test("erro de transporte (timeout, sem code) → contingência COM override", () => {
  const r = classificarErroAtpGate({ message: "fetch failed" });
  assertEquals(r.acao, "falha_verificacao");
  assertEquals(r.semOverride, false);
});

Deno.test("erro não-objeto (throw string) → contingência sem quebrar", () => {
  const r = classificarErroAtpGate("boom");
  assertEquals(r.acao, "falha_verificacao");
  assertEquals(r.semOverride, false);
  assertEquals(typeof r.detalhe, "string");
});
