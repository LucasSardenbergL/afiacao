// Sem rede (`--no-remote` do test:edges): assert inline.
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg ?? `esperado ${String(b)}, veio ${String(a)}`);
}
import { deveReporTelefone, telefoneCompleto, telefoneOmie, telefoneTemDdd } from "./telefone.ts";

Deno.test("telefoneOmie: DDD + número compõem (fixo 8 e celular 9 dígitos), com máscara/espaços", () => {
  assertEquals(telefoneOmie("11", "99999-9999"), "(11) 99999-9999");
  assertEquals(telefoneOmie("47", "3333-4444"), "(47) 3333-4444");
  assertEquals(telefoneOmie(" 21 ", " 9 8888-7777 "), "(21) 98888-7777");
  assertEquals(telefoneOmie("(11)", "99999.9999"), "(11) 99999-9999");
  assertEquals(telefoneOmie("011", "99999-9999"), "(11) 99999-9999", "zero de operadora à esquerda");
});

Deno.test("telefoneOmie: sem DDD o número pelado NÃO vira telefone (null, nunca inventa DDD)", () => {
  assertEquals(telefoneOmie("", "99999-9999"), null);
  assertEquals(telefoneOmie(undefined, "9999-9999"), null);
  assertEquals(telefoneOmie(null, "99999-9999"), null);
  assertEquals(telefoneOmie("0", "99999-9999"), null, "DDD só de zeros");
  assertEquals(telefoneOmie("1", "99999-9999"), null, "DDD de 1 dígito");
  assertEquals(telefoneOmie("111", "99999-9999"), null, "DDD de 3 dígitos sem zero à esquerda");
  assertEquals(telefoneOmie("11", ""), null);
  assertEquals(telefoneOmie("11", "9999"), null, "número curto");
  assertEquals(telefoneOmie(undefined, undefined), null);
});

Deno.test("telefoneOmie: número que JÁ traz o DDD é aceito mesmo sem telefone1_ddd (e sem duplicar)", () => {
  assertEquals(telefoneOmie("", "(11) 99999-9999"), "(11) 99999-9999");
  assertEquals(telefoneOmie(undefined, "4733334444"), "(47) 3333-4444");
  assertEquals(telefoneOmie("11", "11999999999"), "(11) 99999-9999", "DDD repetido no número");
  assertEquals(telefoneOmie("", "+55 11 99999-9999"), "(11) 99999-9999", "com 55 do país");
});

Deno.test("telefoneCompleto: só 10–11 dígitos (ou 55+12–13); o resto é null", () => {
  assertEquals(telefoneCompleto("(11) 99999-9999"), "(11) 99999-9999");
  assertEquals(telefoneCompleto("11 3333 4444"), "(11) 3333-4444");
  assertEquals(telefoneCompleto("5511999999999"), "(11) 99999-9999");
  assertEquals(telefoneCompleto("551133334444"), "(11) 3333-4444");
  assertEquals(telefoneCompleto("99999-9999"), null, "9 dígitos = sem DDD");
  assertEquals(telefoneCompleto("9999-9999"), null, "8 dígitos = sem DDD");
  assertEquals(telefoneCompleto("0111999999999"), null, "13 dígitos sem 55");
  assertEquals(telefoneCompleto("0199999999"), null, "DDD começando em 0");
  assertEquals(telefoneCompleto(""), null);
  assertEquals(telefoneCompleto(null), null);
  assertEquals(telefoneCompleto(undefined), null);
});

Deno.test("deveReporTelefone: repõe só quem NÃO tem DDD e só quando o Omie fornece completo", () => {
  assertEquals(deveReporTelefone("99999-9999", "(11) 99999-9999"), true, "sem DDD → repõe");
  assertEquals(deveReporTelefone("9999-9999", "(47) 3333-4444"), true);
  assertEquals(deveReporTelefone(null, "(11) 99999-9999"), true, "vazio → repõe");
  assertEquals(deveReporTelefone("", "(11) 99999-9999"), true);
  assertEquals(deveReporTelefone("(11) 98888-7777", "(11) 99999-9999"), false, "já completo → NÃO sobrescreve");
  assertEquals(deveReporTelefone("5511988887777", "(11) 99999-9999"), false, "completo com 55 → NÃO sobrescreve");
  assertEquals(deveReporTelefone("99999-9999", null), false, "Omie sem DDD → nada a repor");
  assertEquals(deveReporTelefone(null, null), false);
  assertEquals(telefoneTemDdd("(11) 99999-9999"), true);
  assertEquals(telefoneTemDdd("99999-9999"), false);
});
