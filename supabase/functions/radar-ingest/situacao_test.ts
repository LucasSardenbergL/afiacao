// Testa o CÓDIGO REAL de radar-ingest/situacao.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/radar-ingest/
import { SITUACOES, SITUACOES_IRREGULARES, validarLinhaSituacao } from "./situacao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`);
  }
}

Deno.test("vocabulário RFB: 5 situações, 3 irregulares (03 suspensa, 04 inapta, 08 baixada)", () => {
  assertEquals([...SITUACOES].sort(), ["01", "02", "03", "04", "08"]);
  assertEquals([...SITUACOES_IRREGULARES].sort(), ["03", "04", "08"]);
  assertEquals(SITUACOES_IRREGULARES.has("02"), false);
});

Deno.test("linha válida normaliza (trim, teto de tamanho, data ausente → null)", () => {
  assertEquals(validarLinhaSituacao({
    cnpj: "12ABC34501DE35", situacao: " 08 ", data_situacao: "2026-03-15",
    motivo_codigo: " 01 ", motivo_descricao: "EXTINCAO POR ENCERRAMENTO LIQUIDACAO VOLUNTARIA",
  }), {
    ok: true,
    linha: { cnpj: "12ABC34501DE35", situacao: "08", data_situacao: "2026-03-15", motivo_codigo: "01",
      motivo_descricao: "EXTINCAO POR ENCERRAMENTO LIQUIDACAO VOLUNTARIA" },
  });
  assertEquals(validarLinhaSituacao({ cnpj: "11111111000191", situacao: "02", data_situacao: "", motivo_codigo: "", motivo_descricao: null }), {
    ok: true, linha: { cnpj: "11111111000191", situacao: "02", data_situacao: null, motivo_codigo: null, motivo_descricao: null },
  });
});

Deno.test("descarte por motivo, na ordem formato → DV → situação → data", () => {
  assertEquals(validarLinhaSituacao({ cnpj: "12abc34501de35", situacao: "08" }), { ok: false, motivo: "cnpj_formato" });
  assertEquals(validarLinhaSituacao({ cnpj: "12ABC34501DE36", situacao: "08" }), { ok: false, motivo: "cnpj_dv" });
  assertEquals(validarLinhaSituacao({ cnpj: "11111111000191", situacao: "05" }), { ok: false, motivo: "situacao" });
  assertEquals(validarLinhaSituacao({ cnpj: "11111111000191", situacao: "08", data_situacao: "15/03/2026" }), { ok: false, motivo: "data" });
  assertEquals(validarLinhaSituacao({}), { ok: false, motivo: "cnpj_formato" });
});
