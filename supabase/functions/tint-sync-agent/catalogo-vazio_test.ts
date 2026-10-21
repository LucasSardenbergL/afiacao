// catalogo-vazio_test.ts — o lote de /catalogs sem entidade gravável não abre run.
// Roda no CI via `bun run test:edges` (deno test --no-remote) — SEM import remoto.
//
// Money-path: o ack sem run SÓ pode sair com zero item gravável. Um item gravável que caísse aqui
// seria um lote cacheado pelo conector (hash no 200) e nunca gravado — o dado some calado.
import { ackSemRun, ENTIDADES_CATALOGO, itensGravaveis } from "./catalogo-vazio.ts";

function assertEq(atual: unknown, esperado: unknown, msg: string) {
  if (JSON.stringify(atual) !== JSON.stringify(esperado)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(atual)}`);
  }
}

Deno.test("lote só com entidades que a edge não grava → 0 gravável", () => {
  assertEq(itensGravaveis({ padracores: [{ id: 1 }, { id: 2 }] }), 0, "padracores");
  assertEq(itensGravaveis({ colecoes: [{}], subcolecoes: [{}], personcores: [{}] }), 0, "coleções/personcores");
  assertEq(itensGravaveis({}), 0, "payload vazio");
});

Deno.test("CADA entidade gravável conta — nenhuma cai no ack sem run", () => {
  for (const k of ENTIDADES_CATALOGO) {
    assertEq(itensGravaveis({ [k]: [{ x: 1 }], padracores: [{}] }), 1, `entidade ${k}`);
  }
  assertEq(itensGravaveis({ skus: [{}, {}], precos_base: [{}] }), 3, "soma entre entidades");
});

Deno.test("as entidades são exatamente as que a rota /catalogs grava", () => {
  assertEq([...ENTIDADES_CATALOGO].sort(), ["bases", "corantes", "embalagens", "precos_base", "produtos", "skus"], "lista");
});

Deno.test("valor que não é array não conta (o index o trata como vazio)", () => {
  assertEq(itensGravaveis({ produtos: { a: 1 }, skus: null, bases: "x" }), 0, "não-array");
});

Deno.test("ack sem run: ok, sem erro, sem run — o que o conector confere para cachear o hash", () => {
  const a = ackSemRun("chave-1");
  assertEq([a.ok, a.error_count, a.errors, a.sync_run_id, a.batch_id], [true, 0, [], null, "chave-1"], "ack");
  assertEq(ackSemRun(null).batch_id, null, "sem idempotency key");
});
