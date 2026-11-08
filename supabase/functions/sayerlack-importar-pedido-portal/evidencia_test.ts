// 7.2: o corte do trace da evidência — o fim (onde a leitura falhou) fica, o corte é marcado, ausente fica null.
import { igual } from "../_shared/harness-handler_test.ts";
import { cortarTrace, TETO_TRACE_BYTES } from "./evidencia.ts";

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

Deno.test("trace ausente ou não-lista fica null (nunca lista vazia fabricada)", () => {
  igual([cortarTrace(undefined), cortarTrace(null), cortarTrace("x")], [null, null, null], "null");
});

Deno.test("trace dentro do teto passa intacto", () => {
  const t = [{ step: "login" }, { step: "consulta_lida" }];
  igual(cortarTrace(t), t, "intacto");
});

Deno.test("trace acima do teto: guarda os passos FINAIS, marca o corte e cabe no teto", () => {
  const t = Array.from({ length: 400 }, (_, i) => ({ step: `p${i}`, html: "x".repeat(1000) }));
  const c = cortarTrace(t) as { step: string; passos_omitidos?: number }[];
  igual(c[0].step, "trace_cortado", "marca do corte");
  igual(c[c.length - 1].step, "p399", "o último passo fica");
  igual(c[0].passos_omitidos, 400 - (c.length - 1), "conta o que omitiu");
  igual(bytes(c) <= TETO_TRACE_BYTES, true, "cabe no teto");
});
