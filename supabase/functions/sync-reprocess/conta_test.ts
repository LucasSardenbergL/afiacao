// deno test --no-remote supabase/functions/sync-reprocess/conta_test.ts
import { contaReprocessValida } from "./conta.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

Deno.test("conta — só oben e colacor; rótulo de outra edge, caixa diferente ou não-string é recusado", () => {
  assertEquals([contaReprocessValida("oben"), contaReprocessValida("colacor")], [true, true]);
  for (const v of ["colacor_vendas", "colacor_sc", "vendas", "OBEN", "", null, undefined, 1, ["oben"]]) {
    assertEquals(contaReprocessValida(v), false, `aceitou ${JSON.stringify(v)}`);
  }
});
