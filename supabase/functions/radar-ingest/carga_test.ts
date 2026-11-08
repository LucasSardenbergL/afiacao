// Testa o CÓDIGO REAL de radar-ingest/carga.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/radar-ingest/
import { dedupPorCnpj, lerEsperado, montarLinhaStaging } from "./carga.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`);
  }
}

Deno.test("montarLinhaStaging: não rotula a foto nem toca campos de prospecção", () => {
  const l = montarLinhaStaging({
    cnpj: "12345678000195", cnae_principal: "4744001", razao_social: "X",
    ultimo_lote: "2026-11", prospeccao_status: "descartado", ja_cliente: true, primeira_vista_em: "2026-01-01",
  });
  assertEquals("ultimo_lote" in l, false);
  assertEquals("updated_at" in l, false);
  assertEquals("prospeccao_status" in l, false);
  assertEquals("ja_cliente" in l, false);
  assertEquals("primeira_vista_em" in l, false);
  assertEquals(l.cnaes_secundarios, []);
  assertEquals(l.telefone1, null);
});

Deno.test("dedupPorCnpj: last-wins", () => {
  const r = dedupPorCnpj([{ cnpj: "A", v: 1 }, { cnpj: "B", v: 2 }, { cnpj: "A", v: 3 }]);
  assertEquals(r.length, 2);
  assertEquals(r.find((x) => x.cnpj === "A")?.v, 3);
});

Deno.test("lerEsperado: ausente/zero/negativo/fração/string recusados; inteiro > 0 aceito", () => {
  for (const v of [undefined, null, 0, -1, 1.5, "10", NaN]) assertEquals(lerEsperado(v).ok, false);
  assertEquals(lerEsperado(503929), { ok: true, valor: 503929 });
});
