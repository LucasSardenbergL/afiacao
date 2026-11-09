import { interpretarAcquire, planejarAvanco, resolverConta } from "./import-servidor.ts";

// Asserts locais (o test:edges roda com --no-remote; o repo não importa std remoto nos testes de edge).
function assertEquals(atual: unknown, esperado: unknown, msg = "valor") {
  const a = JSON.stringify(atual), e = JSON.stringify(esperado);
  if (a !== e) throw new Error(`${msg}: esperado ${e}, veio ${a}`);
}
function assertThrows(fn: () => unknown): Error {
  try { fn(); } catch (e) { if (e instanceof Error) return e; throw new Error(`lançou não-Error: ${String(e)}`); }
  throw new Error("esperava exceção e não houve");
}
const ID = "11111111-1111-4111-8111-111111111111";
const TK = "22222222-2222-4222-8222-222222222222";
const ORDEM = ["colacor_sc", "oben", "colacor"] as const;

Deno.test("interpretarAcquire: NULL = sem rodada; cursor válido passa", () => {
  assertEquals(interpretarAcquire(null), null);
  assertEquals(
    interpretarAcquire({ rodada_id: ID, lease_token: TK, conta_slug: null, start_page: 1, total_paginas: 0 }),
    { rodada_id: ID, lease_token: TK, conta_slug: null, start_page: 1, total_paginas: 0 },
  );
});

Deno.test("interpretarAcquire: forma fora do contrato LANÇA (nunca vira 'sem rodada')", () => {
  const e = assertThrows(() => interpretarAcquire({ rodada_id: ID, lease_token: "x", conta_slug: null, start_page: 1, total_paginas: 0 }));
  assertEquals(e.message.startsWith("clientes_import_lease_acquire fora do contrato"), true);
  assertThrows(() => interpretarAcquire([]));
  assertThrows(() => interpretarAcquire({ rodada_id: ID, lease_token: TK, conta_slug: null, start_page: 0, total_paginas: 0 }));
});

Deno.test("resolverConta: slug presente, início, credencial sumida avança e zera a página", () => {
  assertEquals(resolverConta(null, ["colacor_sc", "oben", "colacor"], ORDEM), { indice: 0, mesmaConta: true });
  assertEquals(resolverConta("oben", ["colacor_sc", "oben", "colacor"], ORDEM), { indice: 1, mesmaConta: true });
  // Oben perdeu a credencial: a lista encolhe e o índice 1 passaria a ser Colacor — o slug impede o erro.
  assertEquals(resolverConta("oben", ["colacor_sc", "colacor"], ORDEM), { indice: 1, mesmaConta: false });
  assertEquals(resolverConta("colacor", ["colacor_sc", "oben"], ORDEM), { indice: 2, mesmaConta: false });
  const e = assertThrows(() => resolverConta("acme", ["oben"], ORDEM));
  assertEquals(e.message, "conta do cursor desconhecida: acme");
});

Deno.test("planejarAvanco: lote com mais páginas leva o slug da PRÓXIMA conta pelo índice", () => {
  const r = planejarAvanco({
    imported: 12, skipped: 30, errors: 1, telefones_repostos: 2, hasMore: true, falha: null,
    contas_sem_credencial: [], next: { account_index: 2, start_page: 1, total_paginas: 0 },
  }, ["colacor_sc", "oben", "colacor"]);
  assertEquals(r, {
    conta_slug: "colacor", start_page: 1, total_paginas: 0, importados: 12, pulados: 30, erros: 1,
    telefones_repostos: 2, falha: null, contas_sem_credencial: [], concluida: false,
  });
});

Deno.test("planejarAvanco: fim só com done===true ou hasMore===false; sem hasMore booleano LANÇA", () => {
  assertEquals(planejarAvanco({ done: true, contas_sem_credencial: [{ account: "colacor" }] }, ["oben"]).concluida, true);
  assertEquals(planejarAvanco({ hasMore: false, imported: 3, falha: { conta_abandonada: true } }, ["oben"]).concluida, true);
  const e = assertThrows(() => planejarAvanco({ imported: 3 }, ["oben"]));
  assertEquals(e.message, "resultado do lote sem hasMore booleano — malformado, não é fim");
});

Deno.test("planejarAvanco: next inválido, além da última conta ou contador negativo LANÇA", () => {
  assertThrows(() => planejarAvanco({ hasMore: true, next: { account_index: 0, start_page: 0 } }, ["oben"]));
  const e = assertThrows(() => planejarAvanco({ hasMore: true, next: { account_index: 1, start_page: 1 } }, ["oben"]));
  assertEquals(e.message.startsWith("resultado do lote com hasMore e next além da última conta"), true);
  const n = assertThrows(() => planejarAvanco({ hasMore: true, imported: -1, next: { account_index: 0, start_page: 2 } }, ["oben"]));
  assertEquals(n.message, "resultado do lote com imported inválido: -1");
});
