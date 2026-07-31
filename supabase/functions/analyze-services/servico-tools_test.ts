// Testa o CÓDIGO REAL de servico-tools.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/analyze-services/
//
// Foco: `quantity` multiplica o preço do serviço no pedido de afiação. String
// ou zero ali vira valor errado na nota — mesma classe que o challenge do Codex
// expôs na fase 2 (`1 + "2"` = `"12"`).
import { normalizarItens, numeroFinito, quantidadeValida } from "./servico-tools.ts";

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

const IDS = new Set(["ferr-1", "ferr-2"]);
const ITEM_OK = {
  userToolId: "ferr-1",
  omie_codigo_servico: 4021,
  servico_descricao: "Afiação de serra circular",
  quantity: 3,
};

Deno.test("normalizarItens: item válido passa inteiro", () => {
  const { itens, descartados } = normalizarItens([ITEM_OK], IDS);
  assertEquals(descartados, 0);
  assertEquals(itens.length, 1);
  assertEquals(itens[0].quantity, 3);
  assertEquals(itens[0].omie_codigo_servico, 4021);
});

Deno.test("normalizarItens: ferramenta que NÃO é do cliente é descartada", () => {
  // Um userToolId inventado viraria item órfão no pedido.
  const { itens, descartados } = normalizarItens(
    [ITEM_OK, { ...ITEM_OK, userToolId: "ferr-inventada" }],
    IDS,
  );
  assertEquals(itens.length, 1);
  assertEquals(descartados, 1);
});

Deno.test("normalizarItens: código de serviço ilegível derruba a linha", () => {
  // Sem código não há o que faturar; adivinhar erra o serviço cobrado.
  for (const cod of [null, undefined, "n/a", "", {}]) {
    const { itens, descartados } = normalizarItens(
      [{ ...ITEM_OK, omie_codigo_servico: cod }],
      IDS,
    );
    assertEquals(itens.length, 0, `código ${JSON.stringify(cod)}`);
    assertEquals(descartados, 1);
  }
});

Deno.test("normalizarItens: quantity string vira NUMBER — fecha o 1 + \"2\"", () => {
  const { itens } = normalizarItens([{ ...ITEM_OK, quantity: "2" }], IDS);
  assertEquals(itens[0].quantity, 2);
  assertEquals(typeof itens[0].quantity, "number", "tem de sair number");
  assertEquals(1 + itens[0].quantity, 3, "somar deve dar 3, não \"12\"");
});

Deno.test("normalizarItens: quantity inválida DERRUBA a linha (não vira 1)", () => {
  // "padrão 1" é texto da descrição do campo, não default executado pelo
  // schema. Assumir 1 quando o cliente falou 10 é inventar quantidade — e ela
  // multiplica o preço na nota. A ferramenta ficar de fora é visível; a
  // quantidade errada, não.
  for (const q of [undefined, null, 0, -5, "abc", NaN, {}]) {
    const { itens, descartados } = normalizarItens([{ ...ITEM_OK, quantity: q }], IDS);
    assertEquals(itens.length, 0, `quantity ${JSON.stringify(q)}`);
    assertEquals(descartados, 1, `quantity ${JSON.stringify(q)}`);
  }
});

Deno.test("normalizarItens: ferramenta DUPLICADA vira uma linha só", () => {
  // Duas linhas para a mesma ferramenta = cobrança dobrada; o filtro a jusante
  // compara cada item só contra o carrinho anterior, não entre si.
  const { itens, descartados } = normalizarItens([ITEM_OK, { ...ITEM_OK, quantity: 5 }], IDS);
  assertEquals(itens.length, 1);
  assertEquals(itens[0].quantity, 3, "vale a primeira ocorrência");
  assertEquals(descartados, 1);
});

Deno.test("normalizarItens: descrição vazia derruba a linha", () => {
  const { itens, descartados } = normalizarItens(
    [{ ...ITEM_OK, servico_descricao: "   " }],
    IDS,
  );
  assertEquals(itens.length, 0);
  assertEquals(descartados, 1);
});

Deno.test("normalizarItens: notes vazio não vira campo vazio no pedido", () => {
  const { itens } = normalizarItens([{ ...ITEM_OK, notes: "  " }], IDS);
  assert(!("notes" in itens[0]), "notes em branco não deveria entrar");
  const comNotes = normalizarItens([{ ...ITEM_OK, notes: " urgente, lascada " }], IDS);
  assertEquals(comNotes.itens[0].notes, "urgente, lascada");
});

Deno.test("normalizarItens: lixo no array é contado, não silenciado", () => {
  // O caller avisa o cliente quantos itens ficaram de fora.
  const { itens, descartados } = normalizarItens(["texto", 42, null, ITEM_OK], IDS);
  assertEquals(itens.length, 1);
  assertEquals(descartados, 3);
});

Deno.test("normalizarItens: entrada não-array degrada para vazio", () => {
  for (const v of [null, undefined, "x", 7, {}]) {
    assertEquals(normalizarItens(v, IDS), { itens: [], descartados: 0 }, `entrada ${JSON.stringify(v)}`);
  }
});

// ─────────────────────────────── numéricos ───────────────────────────────

Deno.test("numeroFinito: string AMBÍGUA não vira número", () => {
  for (const v of ["12,50", "R$ 12", "doze", "", "1e3"]) {
    assertEquals(numeroFinito(v), null, `entrada ${JSON.stringify(v)}`);
  }
  assertEquals(numeroFinito("12.5"), 12.5);
  assertEquals(numeroFinito(7), 7);
});

Deno.test("quantidadeValida: fracionário é REJEITADO — a unidade é peça afiada", () => {
  // "2,5 serras" é leitura errada, não meia serra.
  assertEquals(quantidadeValida(2.5), null);
  assertEquals(quantidadeValida("0.5"), null);
  assertEquals(quantidadeValida(3), 3);
  assertEquals(quantidadeValida("4"), 4);
});
