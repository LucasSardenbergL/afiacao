// Testa o CÓDIGO REAL de product-idmap.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test supabase/functions/omie-analytics-sync/product-idmap_test.ts
//
// Money-path: buildProductIdMap resolve omie_codigo_produto -> product_id NULIFICANDO o
// código AMBÍGUO (mesmo número em >1 account — omie_products é UNIQUE (omie_codigo_produto,
// account)). Sem isso, o CMC/saldo lido de UMA empresa seria gravado no product_id de OUTRA
// (contaminação de custo cross-company → EOQ/reposição errado). É a paridade que faltava
// entre syncInventoryFull (que NÃO tinha o guard) e syncInventory (que já nulifica ambíguo).
import { buildProductIdMap } from "./product-idmap.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

// ── Caso 1:1 (realidade de produção hoje: 7921 códigos, cada um em 1 só account) ──
Deno.test("1:1 — código único mapeia para seu product_id", () => {
  const map = buildProductIdMap([
    { id: "id-a", omie_codigo_produto: 100 },
    { id: "id-b", omie_codigo_produto: 200 },
  ]);
  assertEquals(map.get(100), "id-a");
  assertEquals(map.get(200), "id-b");
  assertEquals(map.size, 2);
});

// ── O BUG: mesmo código em 2 accounts (2 product_ids DISTINTOS) → null (não grava no errado) ──
Deno.test("ambíguo — código 12345 em oben E colacor → null (paridade syncInventory)", () => {
  const map = buildProductIdMap([
    { id: "id-oben", omie_codigo_produto: 12345 },
    { id: "id-colacor", omie_codigo_produto: 12345 },
  ]);
  assertEquals(map.get(12345), null); // NÃO 'id-colacor' (last-wins) nem 'id-oben'
});

// ── A ambiguidade NÃO depende da ordem da paginação (qual veio por último) ──
Deno.test("ambíguo — independe da ordem das linhas", () => {
  const ab = buildProductIdMap([
    { id: "id-oben", omie_codigo_produto: 12345 },
    { id: "id-colacor", omie_codigo_produto: 12345 },
  ]);
  const ba = buildProductIdMap([
    { id: "id-colacor", omie_codigo_produto: 12345 },
    { id: "id-oben", omie_codigo_produto: 12345 },
  ]);
  assertEquals(ab.get(12345), null);
  assertEquals(ba.get(12345), null);
});

// ── 3 accounts (3 ids distintos) → null ──
Deno.test("ambíguo — 3 product_ids distintos para o mesmo código → null", () => {
  const map = buildProductIdMap([
    { id: "id-1", omie_codigo_produto: 7 },
    { id: "id-2", omie_codigo_produto: 7 },
    { id: "id-3", omie_codigo_produto: 7 },
  ]);
  assertEquals(map.get(7), null);
});

// ── ROBUSTEZ: a MESMA linha (mesmo product_id) repetida NÃO é ambígua ──
// Distingue "2+ ids DISTINTOS" (ambíguo de verdade) de "2+ ocorrências" (que a paginação
// .range() SEM .order() do syncInventoryFull pode produzir ao repetir uma linha). Repetição
// de paginação não pode custar a cobertura de CMC de um produto legítimo.
Deno.test("robustez — mesma linha (mesmo id) repetida → mantém o id, NÃO vira ambíguo", () => {
  const map = buildProductIdMap([
    { id: "id-x", omie_codigo_produto: 999 },
    { id: "id-x", omie_codigo_produto: 999 },
  ]);
  assertEquals(map.get(999), "id-x");
});

// ── Bordas: linha sem código ou sem id é ignorada; código numérico-string normaliza ──
Deno.test("borda — omie_codigo_produto null/id null são ignorados", () => {
  const map = buildProductIdMap([
    { id: "id-a", omie_codigo_produto: null },
    { id: null, omie_codigo_produto: 5 },
    { id: "id-b", omie_codigo_produto: 6 },
  ]);
  assertEquals(map.has(0), false); // Number(null)===0 NÃO pode virar uma entrada fabricada
  assertEquals(map.has(5), false); // id null → não mapeia
  assertEquals(map.get(6), "id-b");
});

Deno.test("borda — código vindo como string numérica normaliza; não-numérico é ignorado", () => {
  const map = buildProductIdMap([
    { id: "id-a", omie_codigo_produto: "42" },
    { id: "id-b", omie_codigo_produto: "abc" },
  ]);
  assertEquals(map.get(42), "id-a");
  assertEquals(map.has(NaN), false);
  assertEquals(map.size, 1);
});

// ── Só código INTEIRO POSITIVO SEGURO entra (0 / negativo / fracional / "" / >2^53 → fora) ──
Deno.test("borda — 0, negativo, fracional, string vazia e inteiro inseguro são rejeitados", () => {
  const map = buildProductIdMap([
    { id: "id-zero", omie_codigo_produto: 0 },
    { id: "id-neg", omie_codigo_produto: -3 },
    { id: "id-frac", omie_codigo_produto: 4.5 },
    { id: "id-empty", omie_codigo_produto: "" }, // Number("")===0 → não pode virar entrada
    { id: "id-big", omie_codigo_produto: Number.MAX_SAFE_INTEGER + 1 }, // >2^53 arredondaria → fora
    { id: "id-ok", omie_codigo_produto: 7 },
  ]);
  assertEquals(map.has(0), false);
  assertEquals(map.has(-3), false);
  assertEquals(map.has(4.5), false);
  assertEquals(map.has(Number.MAX_SAFE_INTEGER + 1), false);
  assertEquals(map.get(7), "id-ok");
  assertEquals(map.size, 1);
});
