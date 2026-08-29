// Testa o CÓDIGO REAL de reenvio-pedido.ts (guard "já enviado" da fronteira do
// criar_pedido) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/reenvio-pedido_test.ts
//
// Por que este guard existe (achado Codex 2026-08-29, ritual /codex do PR #2117):
// a chave de dedup do Omie é `PV_<sales_order_id>` — DETERMINÍSTICA POR LINHA LOCAL.
// Linha *push* reenviada bate duplicata no Omie e reconcilia (inofensivo). Linha
// *pull* (nascida do sync, hash `omie_<account>_<pid>`) NUNCA usou essa chave ⇒ o
// Omie não tem como deduplicar e CRIA UM PEDIDO NOVO. Pior: o write-back grava o
// pid novo sem tocar o hash, e o próximo sync do pedido original bate 23505 no
// índice parcial uniq_sales_orders_omie_hash → ON CONFLICT no-op → UM PEDIDO REAL
// SOME EM SILÊNCIO (positivação/OTE/comissão perdidas).

import { classificarEnvioPedido, nascidaNoSync } from "./reenvio-pedido.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

// Compara o PAR (permitido, motivo) num assert SÓ. Asserir `permitido` numa linha e `motivo`
// na seguinte parece equivalente e não é: sabotar um ramo faz o teste morrer em
// `true !== false` ANTES de chegar no motivo, e o vermelho deixa de nomear QUAL ramo caiu.
// Medido na falsificação S2 desta entrega — o teste estava fraco, não o guard.
function assertVeredito(
  v: { permitido: boolean; motivo: string | null },
  permitido: boolean,
  motivo: string | null,
  msg?: string,
) {
  assertEquals({ permitido: v.permitido, motivo: v.motivo }, { permitido, motivo }, msg);
}

// ── permitido: a linha local nasceu aqui e ainda não foi ao Omie ──

Deno.test("linha push virgem (pid NULL, hash NULL) → permitido", () => {
  const v = classificarEnvioPedido({ omie_pedido_id: null, hash_payload: null });
  assertVeredito(v, true, null);
});

Deno.test("campos ausentes no objeto (undefined) contam como virgem → permitido", () => {
  // O select do edge devolve as colunas; undefined só apareceria em objeto parcial.
  // Virgem é o estado que DEVE passar — não pode virar recusa por forma.
  const v = classificarEnvioPedido({});
  assertVeredito(v, true, null);
});

Deno.test("hash não-Omie (orçamento/checkout com hash próprio) → permitido", () => {
  const v = classificarEnvioPedido({ omie_pedido_id: null, hash_payload: "checkout_abc123" });
  assertVeredito(v, true, null);
});

// ── recusa 1: já enviado (o pid é prova de que o Omie JÁ criou o PV) ──

Deno.test("pid preenchido em linha push → recusa ja_enviado", () => {
  const v = classificarEnvioPedido({ omie_pedido_id: 4242, hash_payload: null });
  assertVeredito(v, false, "ja_enviado");
});

Deno.test("DEFEITO CENTRAL: linha pull com pid → recusa (ja_enviado vence pull)", () => {
  // omie_oben_42 com pid 42: era isto que ia ao IncluirPedido e duplicava no Omie.
  const v = classificarEnvioPedido({ omie_pedido_id: 42, hash_payload: "omie_oben_42" });
  assertVeredito(v, false, "ja_enviado");
});

Deno.test("pid 0 conta como enviado: o guard usa o MESMO predicado do índice (IS NOT NULL)", () => {
  // Deliberado: "enviado" aqui é `omie_pedido_id IS NOT NULL`, idêntico ao predicado
  // de uniq_sales_orders_omie_pedido_id e ao CHECK de canonicidade. Uma noção PRÓPRIA
  // de "pid válido" (>0) faria o guard divergir do índice — e é dessa fresta entre
  // duas definições de "enviado" que o furo nasce.
  const v = classificarEnvioPedido({ omie_pedido_id: 0, hash_payload: null });
  assertVeredito(v, false, "ja_enviado");
});

// ── recusa 2: linha nascida no sync nunca vira IncluirPedido ──

Deno.test("linha pull SEM pid → recusa linha_do_sync (invariante estrutural)", () => {
  // 0 linhas assim na PROD hoje (medido 2026-08-29), mas o dia que o sync falhar
  // no meio do write-back esta é a porta aberta.
  const v = classificarEnvioPedido({ omie_pedido_id: null, hash_payload: "omie_colacor_sc_99" });
  assertVeredito(v, false, "linha_do_sync");
});

Deno.test("o prefixo é ancorado no INÍCIO (hash que só CONTÉM 'omie_' não é pull)", () => {
  const v = classificarEnvioPedido({ omie_pedido_id: null, hash_payload: "checkout_omie_oben_1" });
  assertEquals(v.permitido, true, "prefixo desancorado recusaria linha legítima");
});

// ── recusa 3: fail-closed em linha ausente/ilegível ──

Deno.test("linha ausente (null) → recusa linha_ausente, NUNCA permitido", () => {
  // Hoje o edge lê com .maybeSingle() e ignora o error: linha ausente seguia para o
  // IncluirPedido e só falhava no write-back — DEPOIS de o pedido existir no Omie
  // (linha órfã). Ausente ≠ zero: recusar deixa o pedido local intacto p/ retry.
  const v = classificarEnvioPedido(null);
  assertVeredito(v, false, "linha_ausente");
});

Deno.test("linha undefined → recusa linha_ausente", () => {
  assertEquals(classificarEnvioPedido(undefined).motivo, "linha_ausente");
});

Deno.test("shape fora do contrato (array/string/número) → recusa linha_ausente", () => {
  for (const lixo of [[] as unknown, "x" as unknown, 7 as unknown]) {
    const v = classificarEnvioPedido(lixo as never);
    assertVeredito(v, false, "linha_ausente", `shape ${JSON.stringify(lixo)}`);
  }
});

// ── detalhe: mensagem existe em TODA recusa (nunca recusa opaca) ──

Deno.test("toda recusa carrega detalhe não-vazio; permitido carrega detalhe null", () => {
  const recusas = [
    classificarEnvioPedido(null),
    classificarEnvioPedido({ omie_pedido_id: 1, hash_payload: null }),
    classificarEnvioPedido({ omie_pedido_id: null, hash_payload: "omie_oben_1" }),
  ];
  for (const r of recusas) {
    assertEquals(r.permitido, false);
    if (typeof r.detalhe !== "string" || r.detalhe.length === 0) {
      throw new Error(`recusa ${r.motivo} sem detalhe — recusa opaca`);
    }
  }
  assertEquals(classificarEnvioPedido({}).detalhe, null);
});

// ── predicado exportado (usado pelo CHECK de canonicidade como espelho conceitual) ──

Deno.test("nascidaNoSync: só prefixo 'omie_' no início, e só string", () => {
  assertEquals(nascidaNoSync("omie_oben_42"), true);
  assertEquals(nascidaNoSync("omie_colacor_sc_7"), true);
  assertEquals(nascidaNoSync("checkout_1"), false);
  assertEquals(nascidaNoSync("x_omie_1"), false);
  assertEquals(nascidaNoSync(null), false);
  assertEquals(nascidaNoSync(undefined), false);
  assertEquals(nascidaNoSync(""), false);
});
