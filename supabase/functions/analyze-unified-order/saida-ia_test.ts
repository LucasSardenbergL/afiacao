// Testa o CÓDIGO REAL de saida-ia.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/analyze-unified-order/
//
// Foco: a quantidade string que FABRICA número ao somar (challenge do Codex); o
// tool_use múltiplo, que entregaria pedido parcial completo; e a FRONTEIRA DE
// SAÍDA — a IA não precifica: nenhum preço sai desta edge (montarRespostaAnalise
// + a canária `ia-nao-precifica-v1`, com controle de calibração).
import {
  apenasCampos,
  CAMPOS_SAIDA_PRODUTO,
  CAMPOS_SAIDA_SERVICO,
  CAMPOS_SAIDA_SUGESTAO,
  canariaSemPreco,
  extrairToolUseUnico,
  montarRespostaAnalise,
  numeroFinito,
  quantidadeValida,
  type RespostaAnalise,
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
    quantity: 2,
  });
  assertEquals(item!.codigo, "FL.6269.02");
  assertEquals(item!.descricao, "Verniz PU");
  assertEquals(item!.account, "oben");
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
    { product_id: "p1", quantity: 1 },
    "lixo",
    { product_id: "p2", quantity: "3" },
  ]);
  assertEquals(out.length, 2);
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

// ─────────────────── fronteira de SAÍDA: a IA não precifica ───────────────────

/** A forma VELHA do corpo de resposta: os arrays iam como estavam (spread), preço junto. */
function montarFormaVelha(entrada: Parameters<typeof montarRespostaAnalise>[0]): RespostaAnalise {
  return {
    products: entrada.products.map((p) => ({ ...p }) as Record<string, unknown>),
    services: entrada.services.map((p) => ({ ...p }) as Record<string, unknown>),
    suggestions: entrada.suggestions.map((p) => ({ ...p }) as Record<string, unknown>),
    customer: entrada.customer,
    imagens_rejeitadas: entrada.imagens_rejeitadas,
    message: entrada.message,
  };
}

const ENTRADA_COM_PRECO = {
  products: [
    // o que o LLM devolvia (ele via só a TABELA no prompt) + o que o resgate preenchia
    { product_id: "p1", codigo: "FL.1", descricao: "Verniz", quantity: 2, account: "oben", unit_price: 30.5, notes: "urgente" },
    // campo alucinado com nome de preço que nenhuma lista de bloqueio previa
    { product_id: "p2", quantity: 1, account: "colacor", preco: 12, valor: 7 },
  ],
  services: [{ userToolId: "t1", omie_codigo_servico: 900, servico_descricao: "Afiação", quantity: 1, unit_price: 50 }],
  suggestions: [
    { type: "product", product_id: "p3", descricao: "Thinner", reason: "histórico", quantity: 1, account: "oben", unit_price: 99 },
  ],
  customer: { nome_fantasia: "X" },
  imagens_rejeitadas: [],
  message: "ok",
};

Deno.test("montarRespostaAnalise: NENHUM preço sai — unit_price do LLM, `preco` alucinado, nem em serviço", () => {
  const out = montarRespostaAnalise(ENTRADA_COM_PRECO);
  for (const item of [...out.products, ...out.services, ...out.suggestions]) {
    const chavesDePreco = Object.keys(item).filter((k) => /pre[cç]o|price|valor/i.test(k));
    assertEquals(chavesDePreco, [], `item ${JSON.stringify(item)}`);
  }
});

Deno.test("montarRespostaAnalise: o item SAI com os campos do contrato (lista vazia seria o sempre-verde)", () => {
  const out = montarRespostaAnalise(ENTRADA_COM_PRECO);
  assertEquals(out.products, [
    { product_id: "p1", codigo: "FL.1", descricao: "Verniz", quantity: 2, account: "oben", notes: "urgente" },
    { product_id: "p2", quantity: 1, account: "colacor" },
  ]);
  assertEquals(out.services, [{ userToolId: "t1", omie_codigo_servico: 900, servico_descricao: "Afiação", quantity: 1 }]);
  assertEquals(out.suggestions, [
    { type: "product", product_id: "p3", descricao: "Thinner", quantity: 1, account: "oben", reason: "histórico" },
  ]);
  assertEquals(out.customer, { nome_fantasia: "X" });
  assertEquals(out.message, "ok");
});

Deno.test("montarRespostaAnalise: CONTROLE — a forma velha sobre a MESMA entrada deixaria o preço sair", () => {
  // Sem este controle, o teste acima passaria também com uma fixture SEM preço (não discriminaria).
  const velha = montarFormaVelha(ENTRADA_COM_PRECO);
  assertEquals(velha.products[0].unit_price, 30.5);
  assertEquals(velha.suggestions[0].unit_price, 99);
});

Deno.test("apenasCampos: campo ausente ou undefined NÃO vira chave (ausente ≠ preenchido)", () => {
  assertEquals(apenasCampos({ product_id: "p1", notes: undefined }, CAMPOS_SAIDA_PRODUTO), { product_id: "p1" });
});

Deno.test("listas de saída: nenhuma contém campo de preço (sabotar a lista tem de ficar vermelho aqui)", () => {
  for (const campo of [...CAMPOS_SAIDA_PRODUTO, ...CAMPOS_SAIDA_SERVICO, ...CAMPOS_SAIDA_SUGESTAO]) {
    assert(!/pre[cç]o|price|valor/i.test(campo), `lista de saída contém campo de preço: ${campo}`);
  }
});

Deno.test("canariaSemPreco: verde com a fronteira real — 0 preços e os 2 itens na saída", () => {
  // O envelope (`canary`, `contrato` literal) é do bloco da canária em index.ts — pinado pelo vitest.
  assertEquals(canariaSemPreco(), { precos_na_saida: 0, itens_na_saida: 2, ok: true });
});

Deno.test("canariaSemPreco: CONTROLE — com a forma velha a canária fica VERMELHA (os 3 preços da fixture saem)", () => {
  const r = canariaSemPreco(montarFormaVelha);
  assertEquals(r.ok, false);
  assertEquals(r.precos_na_saida, 3);
  assertEquals(r.itens_na_saida, 2);
});

Deno.test("canariaSemPreco: CONTROLE — fronteira que devolve listas VAZIAS também fica vermelha (sempre-verde)", () => {
  const vazia: typeof montarRespostaAnalise = (e) => ({ ...montarRespostaAnalise(e), products: [], suggestions: [] });
  const r = canariaSemPreco(vazia);
  assertEquals(r.precos_na_saida, 0);
  assertEquals(r.itens_na_saida, 0);
  assertEquals(r.ok, false);
});
