// Testa o CÓDIGO REAL de saida-ia.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/analyze-unified-order/
//
// Foco: os dois caminhos de pedido incorreto achados no challenge do Codex —
// preço string que explode no checkout e quantidade string que FABRICA número
// ao somar; mais o tool_use múltiplo, que entregaria pedido parcial completo.
import {
  extrairToolUseUnico,
  numeroFinito,
  precoValido,
  quantidadeValida,
  sanitizarItemIA,
  sanitizarListaIA,
} from "./saida-ia.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(
      `${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`,
    );
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ─────────────────────────────── numeroFinito ───────────────────────────────

Deno.test("numeroFinito: aceita number finito e string numérica limpa", () => {
  assertEquals(numeroFinito(12.5), 12.5);
  assertEquals(numeroFinito("12.50"), 12.5);
  assertEquals(numeroFinito(" 7 "), 7);
  assertEquals(numeroFinito(0), 0);
  assertEquals(numeroFinito(-3), -3);
});

Deno.test("numeroFinito: valor AMBÍGUO não vira número (precisão > recall)", () => {
  // "12,50" é 12.5 ou 1250? Adivinhar aqui vira preço errado no pedido.
  for (const v of ["12,50", "R$ 12,50", "12.50.00", "doze", "", "  ", "1e3", "0x10"]) {
    assertEquals(numeroFinito(v), null, `entrada ${JSON.stringify(v)}`);
  }
});

Deno.test("numeroFinito: não-finito e não-escalar degradam para null", () => {
  for (const v of [NaN, Infinity, -Infinity, null, undefined, {}, [], true]) {
    assertEquals(numeroFinito(v), null, `entrada ${JSON.stringify(v)}`);
  }
});

// ──────────────────────────────── precoValido ────────────────────────────────

Deno.test("precoValido: zero e negativo NÃO viram preço", () => {
  // ausente ≠ zero: R$0 sugerido como "praticado" é fabricação.
  for (const v of [0, -1, "0", "-5"]) {
    assertEquals(precoValido(v), undefined, `entrada ${JSON.stringify(v)}`);
  }
});

Deno.test("precoValido: string numérica vira NUMBER, não fica string", () => {
  // O bug: "12.50" > 0 é true por coerção, entra no carrinho como string e
  // explode no .toFixed(2) do checkout.
  const p = precoValido("12.50");
  assertEquals(p, 12.5);
  assertEquals(typeof p, "number", "tem de sair como number");
});

// ────────────────────────────── quantidadeValida ──────────────────────────────

Deno.test("quantidadeValida: string vira number — fecha o 1 + \"2\" = \"12\"", () => {
  const q = quantidadeValida("2");
  assertEquals(q, 2);
  assertEquals(typeof q, "number");
  assertEquals(1 + q, 3, "somar com item existente tem de dar 3, não \"12\"");
});

Deno.test("quantidadeValida: inválida/ausente cai no default 1 do schema", () => {
  for (const v of [undefined, null, 0, -2, "abc", NaN, {}]) {
    assertEquals(quantidadeValida(v), 1, `entrada ${JSON.stringify(v)}`);
  }
});

Deno.test("quantidadeValida: fracionário é preservado (litro/kg são legítimos)", () => {
  assertEquals(quantidadeValida(2.5), 2.5);
  assertEquals(quantidadeValida("0.5"), 0.5);
});

// ─────────────────────────────── sanitizarItemIA ───────────────────────────────

Deno.test("sanitizarItemIA: preço inválido SAI do item (cai na tabela)", () => {
  const item = sanitizarItemIA({ product_id: "p1", unit_price: "abc", quantity: 3 });
  assert(item !== null, "deveria sanitizar");
  assert(!("unit_price" in item!), "campo tem de sumir, não virar 0");
  assertEquals(item!.quantity, 3);
});

Deno.test("sanitizarItemIA: quantity ausente vira 1 em vez de virar NaN no carrinho", () => {
  const item = sanitizarItemIA({ product_id: "p1" });
  assertEquals(item!.quantity, 1);
});

Deno.test("sanitizarItemIA: preserva os demais campos verbatim", () => {
  const item = sanitizarItemIA({
    product_id: "p1",
    codigo: "FL.6269.02",
    descricao: "Verniz PU",
    account: "oben",
    unit_price: 30.5,
    quantity: 2,
  });
  assertEquals(item!.codigo, "FL.6269.02");
  assertEquals(item!.descricao, "Verniz PU");
  assertEquals(item!.account, "oben");
  assertEquals(item!.unit_price, 30.5);
});

Deno.test("sanitizarItemIA: omie_codigo_servico ilegível sai do item", () => {
  const item = sanitizarItemIA({ userToolId: "t1", omie_codigo_servico: "n/a" });
  assert(!("omie_codigo_servico" in item!), "código inválido não pode ir para o Omie");
});

Deno.test("sanitizarItemIA: não-objeto não vira item de pedido", () => {
  for (const v of ["texto", 42, null, undefined, ["a"]]) {
    assertEquals(sanitizarItemIA(v), null, `entrada ${JSON.stringify(v)}`);
  }
});

Deno.test("sanitizarListaIA: entrada não-array degrada para lista vazia", () => {
  assertEquals(sanitizarListaIA(null), []);
  assertEquals(sanitizarListaIA("x"), []);
  assertEquals(sanitizarListaIA(undefined), []);
});

Deno.test("sanitizarListaIA: item inválido é descartado, os bons passam", () => {
  const out = sanitizarListaIA([
    { product_id: "p1", unit_price: 10, quantity: 1 },
    "lixo",
    { product_id: "p2", unit_price: "20.00", quantity: "3" },
  ]);
  assertEquals(out.length, 2);
  assertEquals(out[1].unit_price, 20);
  assertEquals(out[1].quantity, 3);
});

// ───────────────────────────── extrairToolUseUnico ─────────────────────────────

Deno.test("extrairToolUseUnico: um bloco devolve o input", () => {
  const r = extrairToolUseUnico([
    { type: "text" },
    { type: "tool_use", input: { products: [] } },
  ]);
  assert(r.ok, "deveria aceitar um bloco");
  if (!r.ok) return;
  assertEquals(r.input, { products: [] });
});

Deno.test("extrairToolUseUnico: DOIS blocos são recusados, não silenciosamente cortados", () => {
  // Sem disable_parallel_tool_use o modelo pode emitir um bloco por grupo de
  // itens; pegar o primeiro entregaria pedido PARCIAL com cara de completo.
  const r = extrairToolUseUnico([
    { type: "tool_use", input: { products: [{ id: "a" }] } },
    { type: "tool_use", input: { products: [{ id: "b" }] } },
  ]);
  assert(!r.ok, "dois blocos têm de ser recusados");
  if (r.ok) return;
  assertEquals(r.motivo, "multiplo");
  assertEquals(r.quantidade, 2);
});

Deno.test("extrairToolUseUnico: nenhum bloco é 'ausente', distinto de 'multiplo'", () => {
  const r = extrairToolUseUnico([{ type: "text" }]);
  assert(!r.ok, "deveria recusar");
  if (r.ok) return;
  assertEquals(r.motivo, "ausente");
  assertEquals(r.quantidade, 0);
});
