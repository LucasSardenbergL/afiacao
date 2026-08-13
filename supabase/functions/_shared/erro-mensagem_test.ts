// Testa o CÓDIGO REAL de erro-mensagem.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/erro-mensagem_test.ts
//
// Espelha o oráculo vitest de src/lib/erro-mensagem.ts. O caso que motiva o módulo é o
// segundo teste: o `error` do supabase-js é objeto PLANO, e o idiom antigo
// (`instanceof Error ? err.message : String(err)`) o transforma em "[object Object]".
import { mensagemDeErro } from "./erro-mensagem.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg ?? `esperava ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}

Deno.test("Error normal → a message", () => {
  assertEquals(mensagemDeErro(new Error("falhou de verdade")), "falhou de verdade");
});

Deno.test("objeto PLANO do supabase-js → a message (o caso que motiva o módulo)", () => {
  // `String()` neste objeto renderia "[object Object]" — a mensagem acionável existe e
  // morreria na fronteira.
  assertEquals(
    mensagemDeErro({ message: "canceling statement due to statement timeout", code: "57014" }),
    "canceling statement due to statement timeout",
  );
});

Deno.test("objeto SEM message → null, NUNCA '[object Object]'", () => {
  // Ausente ≠ mensagem fabricada: quem chama decide o fallback do seu contexto.
  assertEquals(mensagemDeErro({ code: "57014" }), null);
});

Deno.test("string crua → ela mesma, aparada", () => {
  assertEquals(mensagemDeErro("  boom  "), "boom");
});

Deno.test("string vazia / só espaço → null", () => {
  assertEquals(mensagemDeErro(""), null);
  assertEquals(mensagemDeErro("   "), null);
});

Deno.test("message vazia ou não-string → null", () => {
  assertEquals(mensagemDeErro({ message: "" }), null);
  assertEquals(mensagemDeErro({ message: "   " }), null);
  assertEquals(mensagemDeErro({ message: 42 }), null);
});

Deno.test("null / undefined → null", () => {
  assertEquals(mensagemDeErro(null), null);
  assertEquals(mensagemDeErro(undefined), null);
});

Deno.test("primitivo não-string → String() dele (último recurso, sem risco de [object Object])", () => {
  assertEquals(mensagemDeErro(404), "404");
  assertEquals(mensagemDeErro(false), "false");
});
