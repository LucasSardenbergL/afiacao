// deno test --no-remote supabase/functions/_shared/omie-codigo-item_test.ts
//
// ⚠️ O PONTO DESTA SUÍTE: a régua não é "converteu para número", é "é identidade CONFIÁVEL de
// linha". Um teste que só afirma `normalizar(7) === 7` passa com `Number(x)` cru — e `Number("")`,
// `Number(null)`, `Number("0")` e `Number(false)` são todos 0. Zero gravado na coluna vira
// identidade FALSA que casa a linha errada dentro do pedido, no caminho do dinheiro. Por isso cada
// caso abaixo fixa uma entrada que `Number()` sozinho aceitaria e que a régua tem de REJEITAR.

import { identidadeDistinta, normalizarCodigoItemOmie } from "./omie-codigo-item.ts";

// `eq` local em vez de std/assert remoto: `test:edges` roda com `--no-remote` e o flag não se
// afrouxa por conveniência de teste (CLAUDE.md). `rotular` mantém não-finitos VISÍVEIS — o
// `JSON.stringify` cru serializa Infinity/NaN como "null", indistinguível de null de verdade, e
// foi exatamente essa cegueira que deixou uma mutação sobreviver em `desconto-omie_test.ts`.
function rotular(v: unknown): string {
  if (typeof v === "number" && !Number.isFinite(v)) return `<não-finito:${String(v)}>`;
  return JSON.stringify(v) ?? "<undefined>";
}
function eq(a: unknown, b: unknown, msg: string) {
  if (rotular(a) !== rotular(b)) throw new Error(`${msg}: ${rotular(a)} !== ${rotular(b)}`);
}

Deno.test("codigo_item válido atravessa como número", () => {
  eq(normalizarCodigoItemOmie(7), 7, "inteiro positivo");
  eq(normalizarCodigoItemOmie("12345678901"), 12345678901, "string numérica do JSON do Omie");
});

Deno.test("DISCRIMINANTE: o que `Number()` viraria 0 é REJEITADO — identidade falsa é pior que ausente", () => {
  for (const bruto of ["", null, undefined, 0, "0", false, []]) {
    eq(normalizarCodigoItemOmie(bruto), null, `Number() daria 0 para ${rotular(bruto)}`);
  }
});

Deno.test("shape inesperado, fracionário e negativo caem para null", () => {
  eq(normalizarCodigoItemOmie("abc"), null, "texto");
  eq(normalizarCodigoItemOmie({}), null, "objeto");
  eq(normalizarCodigoItemOmie(1.5), null, "fracionário");
  eq(normalizarCodigoItemOmie(-3), null, "negativo");
  eq(normalizarCodigoItemOmie(Number.NaN), null, "NaN");
  eq(normalizarCodigoItemOmie(Number.POSITIVE_INFINITY), null, "Infinity");
  // 2^53 já não é safe integer: a partir daí dois codigo_item distintos colapsam no mesmo número.
  eq(normalizarCodigoItemOmie(9007199254740992), null, "acima do inteiro representável");
});

Deno.test("G-a: identidade repetida no MESMO pedido reprova o pedido inteiro", () => {
  eq(identidadeDistinta([1, 2, 3]), true, "distintas");
  eq(identidadeDistinta([7, 7]), false, "duas linhas com o mesmo codigo_item");
  eq(identidadeDistinta([1, 2, 1]), false, "repetida não-adjacente");
});

Deno.test("G-a: NULL não é duplicata de NULL — ausente não é valor", () => {
  // Duas linhas sem identidade são o caminho LEGADO (casamento por SKU), não ambiguidade de
  // identidade. Tratar null como repetido zeraria a adoção de todo pedido parcialmente lido.
  eq(identidadeDistinta([null, null]), true, "duas ausências");
  eq(identidadeDistinta([null, 5, null]), true, "parcial com ausências");
  eq(identidadeDistinta([]), true, "vazio");
});
