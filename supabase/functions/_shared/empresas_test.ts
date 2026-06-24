// deno test supabase/functions/_shared/empresas_test.ts
import { resolverEmpresas, EMPRESAS_VALIDAS } from "./empresas.ts";

function assertEq(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
  }
}

Deno.test("ALL expande para todas as empresas (case-insensitive)", () => {
  assertEq(resolverEmpresas("ALL"), ["OBEN", "COLACOR"]);
  assertEq(resolverEmpresas("all"), ["OBEN", "COLACOR"]);
});

Deno.test("empresa específica → só ela", () => {
  assertEq(resolverEmpresas("OBEN"), ["OBEN"]);
  assertEq(resolverEmpresas("colacor"), ["COLACOR"]);
});

Deno.test("vazio/ausente → default OBEN", () => {
  assertEq(resolverEmpresas(null), ["OBEN"]);
  assertEq(resolverEmpresas(undefined), ["OBEN"]);
  assertEq(resolverEmpresas(""), ["OBEN"]);
});

Deno.test("REGRESSÃO do bug: 'ALL' agora é válido (antes caía em null → 400 silencioso)", () => {
  // O cron baseline manda empresa=ALL; a edge respondia 400 antes de logar 'running'.
  assertEq(resolverEmpresas("ALL") !== null, true);
  // Genuinamente inválida continua null:
  assertEq(resolverEmpresas("XPTO"), null);
  assertEq(resolverEmpresas("oben "), null); // espaço não é normalizado de propósito
});

Deno.test("EMPRESAS_VALIDAS = OBEN, COLACOR", () => {
  assertEq([...EMPRESAS_VALIDAS], ["OBEN", "COLACOR"]);
});
