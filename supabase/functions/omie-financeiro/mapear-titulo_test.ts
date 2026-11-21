// Roda o CÓDIGO REAL de mapear-titulo.ts (valor ausente nunca vira R$ 0).
import { valorDocumentoTitulo } from "./mapear-titulo.ts";

function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

Deno.test("sem valor nenhum → null", () => assertEquals(valorDocumentoTitulo({}), null));
Deno.test("string vazia → null", () => assertEquals(valorDocumentoTitulo({ valor_documento: "" }), null));
Deno.test("0 explícito do Omie continua 0", () => assertEquals(valorDocumentoTitulo({ valor_documento: 0 }), 0));
Deno.test("fallback nValorTitulo string numérica", () => assertEquals(valorDocumentoTitulo({ nValorTitulo: "1234.5" }), 1234.5));
Deno.test("lixo não numérico → null", () => assertEquals(valorDocumentoTitulo({ valor_documento: "abc" }), null));
Deno.test("negativo → null", () => assertEquals(valorDocumentoTitulo({ valor_documento: -5 }), null));
Deno.test("valor_documento ilegível cai no nValorTitulo", () =>
  assertEquals(valorDocumentoTitulo({ valor_documento: "abc", nValorTitulo: 80 }), 80));
Deno.test("false com fallback → usa o fallback (nunca 0)", () =>
  assertEquals(valorDocumentoTitulo({ valor_documento: false, nValorTitulo: 500 }), 500));
Deno.test("[] com fallback → usa o fallback (nunca 0)", () =>
  assertEquals(valorDocumentoTitulo({ valor_documento: [], nValorTitulo: 500 }), 500));
Deno.test("false sozinho → null", () => assertEquals(valorDocumentoTitulo({ valor_documento: false }), null));
Deno.test("true/objeto → null", () => assertEquals(valorDocumentoTitulo({ valor_documento: true, nValorTitulo: {} }), null));
Deno.test("string com vírgula decimal não é aceita (Omie manda ponto) → null", () =>
  assertEquals(valorDocumentoTitulo({ valor_documento: "1.234,50" }), null));
