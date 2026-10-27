// Sem rede (`--no-remote` do test:edges): assert inline, como os demais _test.ts desta edge.
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg ?? `esperado ${String(b)}, veio ${String(a)}`);
}
import { lookupDevolveuOMesmoDocumento } from "./lookup-documento.ts";

Deno.test("numérico: cru e com máscara conferem; outro documento não", () => {
  assertEquals(lookupDevolveuOMesmoDocumento("12345678000195", "12345678000195"), true);
  assertEquals(lookupDevolveuOMesmoDocumento("12345678000195", "12.345.678/0001-95"), true);
  assertEquals(lookupDevolveuOMesmoDocumento("12345678000195", "12.345.678/0001-96"), false);
  assertEquals(lookupDevolveuOMesmoDocumento("12345678000195", "12345678909"), false);
});

Deno.test("alfanumérico (exemplo oficial RFB 12.ABC.345/01DE-35): cru, máscara exata e minúsculo conferem", () => {
  assertEquals(lookupDevolveuOMesmoDocumento("12ABC34501DE35", "12ABC34501DE35"), true);
  assertEquals(lookupDevolveuOMesmoDocumento("12ABC34501DE35", "12.ABC.345/01DE-35"), true);
  assertEquals(lookupDevolveuOMesmoDocumento("12ABC34501DE35", "12.abc.345/01de-35"), true);
});

Deno.test("alfanumérico MUTILADO pelo ERP (letras removidas) ou outro cliente NÃO confere — o lead fica na fila", () => {
  assertEquals(lookupDevolveuOMesmoDocumento("12ABC34501DE35", "123450135"), false);
  assertEquals(lookupDevolveuOMesmoDocumento("12ABC34501DE35", "12345678000195"), false);
  assertEquals(lookupDevolveuOMesmoDocumento("AEG12345678909", "12345678909"), false);
});

Deno.test("sem documento (vazio, null, undefined) nunca confere", () => {
  assertEquals(lookupDevolveuOMesmoDocumento("12345678000195", ""), false);
  assertEquals(lookupDevolveuOMesmoDocumento("12345678000195", null), false);
  assertEquals(lookupDevolveuOMesmoDocumento("12345678000195", undefined), false);
  assertEquals(lookupDevolveuOMesmoDocumento("", ""), false);
});

Deno.test("os DOIS lados vazios não conferem (sem documento não se afirma identidade)", () => {
  assertEquals(lookupDevolveuOMesmoDocumento("", ""), false);
  assertEquals(lookupDevolveuOMesmoDocumento("", null), false);
  assertEquals(lookupDevolveuOMesmoDocumento("", "---"), false);
});

Deno.test("retorno com letra fora do rótulo NÃO casa pelos dígitos (Codex retroativo #3311)", () => {
  // O só-dígitos reduzia estes retornos a 12345678909 / 12345678000195 e o código alheio passava.
  for (const retornado of ["123ABC45678909", "abc123.456.789-09", "1234567800019A", "ⒶⒷ12345678909", "１２３４５６７８９０９"]) {
    assertEquals(lookupDevolveuOMesmoDocumento("12345678909", retornado), false, `retornado ${retornado}`);
  }
  assertEquals(lookupDevolveuOMesmoDocumento("12345678000195", "12ABC345678000195"), false);
});

Deno.test("retorno não-string não confere; retornos válidos seguem conferindo", () => {
  assertEquals(lookupDevolveuOMesmoDocumento("12345678909", 12345678909), false);
  assertEquals(lookupDevolveuOMesmoDocumento("12345678909", undefined), false);
  assertEquals(lookupDevolveuOMesmoDocumento("12345678909", "123.456.789-09"), true);
  assertEquals(lookupDevolveuOMesmoDocumento("12345678909", "CPF: 123.456.789-09"), true);
  assertEquals(lookupDevolveuOMesmoDocumento("12ABC34501DE35", "12.abc.345/01de-35"), true);
});
