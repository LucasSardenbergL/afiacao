// Testa o CÓDIGO REAL de radar-ingest/cnpj.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/radar-ingest/
import { CNPJ_RE, cnpjValido, dvCnpj, motivoDescarte } from "./cnpj.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`);
  }
}

// Oráculo externo: exemplo OFICIAL da RFB (12.ABC.345/01DE-35).
Deno.test("dvCnpj reproduz o exemplo oficial da RFB", () => {
  assertEquals(dvCnpj("12ABC34501DE"), "35");
});

Deno.test("dvCnpj coincide com a regra clássica para base numérica (e resto<2 → 0)", () => {
  assertEquals(dvCnpj("000001230001"), "22");
  assertEquals(dvCnpj("998887770001"), "00");
});

Deno.test("dvCnpj rejeita base fora de [0-9A-Z]{12}", () => {
  assertEquals(dvCnpj("12abc34501DE"), null);
  assertEquals(dvCnpj("12ABC34501D"), null);
});

Deno.test("CNPJ_RE: 12 alfanuméricos + 2 dígitos; minúscula e DV com letra falham", () => {
  assertEquals(CNPJ_RE.test("12ABC34501DE35"), true);
  assertEquals(CNPJ_RE.test("00000123000122"), true);
  assertEquals(CNPJ_RE.test("12abc34501DE35"), false);
  assertEquals(CNPJ_RE.test("12ABC34501DE3A"), false);
});

Deno.test("cnpjValido exige formato E DV", () => {
  assertEquals(cnpjValido("12ABC34501DE35"), true);
  assertEquals(cnpjValido("12ABC34501DE36"), false);
  assertEquals(cnpjValido("00000123000144"), false);
});

Deno.test("motivoDescarte: formato → dv → cnae → null (válida)", () => {
  assertEquals(motivoDescarte("12abc34501DE35", "3101200"), "cnpj_formato");
  assertEquals(motivoDescarte(undefined, "3101200"), "cnpj_formato");
  assertEquals(motivoDescarte("12ABC34501DE36", "3101200"), "cnpj_dv");
  assertEquals(motivoDescarte("12ABC34501DE35", "31012"), "cnae");
  assertEquals(motivoDescarte("12ABC34501DE35", "3101200"), null);
  assertEquals(motivoDescarte("00000123000122", "3101200"), null);
});
