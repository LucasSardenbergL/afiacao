// Testa o CÓDIGO REAL de entrada.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/kb-extract-specs/entrada_test.ts
//
// POR QUE EXISTE — achado do Codex no #2791: o prompt levava `content_extracted.slice(0, 50_000)`.
// Boletim maior que isso perdia o fim em silêncio, o modelo devolvia `tool_use` normal e o draft
// virava `ready` com specs ausentes que pareciam "o boletim não informa" (ausente ≠ completo).
import { removerComentarios } from "../_shared/limpeza-fonte.ts";
import { avaliarEntradaBoletim, LIMITE_ENTRADA_CHARS } from "./entrada.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg ?? `esperava ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}

function assertIncludes(texto: string, trecho: string) {
  if (!texto.includes(trecho)) throw new Error(`esperava ${JSON.stringify(trecho)} em ${JSON.stringify(texto)}`);
}

Deno.test("texto no limite exato passa inteiro, sem aviso", () => {
  const texto = "a".repeat(LIMITE_ENTRADA_CHARS);
  const r = avaliarEntradaBoletim(texto);
  assertEquals(r.excede, false);
  if (!r.excede) assertEquals(r.texto, texto);
});

Deno.test("texto acima do limite EXCEDE e não entrega recorte nenhum", () => {
  const r = avaliarEntradaBoletim("a".repeat(LIMITE_ENTRADA_CHARS + 1));
  assertEquals(r.excede, true);
  assertEquals("texto" in r, false, "quem excede não pode carregar um texto cortado para o prompt");
  if (r.excede) {
    assertEquals(r.tamanho, LIMITE_ENTRADA_CHARS + 1);
    assertIncludes(r.motivo, "entrada truncada");
    assertIncludes(r.motivo, String(LIMITE_ENTRADA_CHARS + 1));
  }
});

Deno.test("o limite é o herdado (50.000): mudar o corte é decisão medida, não efeito colateral", () => {
  assertEquals(LIMITE_ENTRADA_CHARS, 50_000);
});

// A FIAÇÃO no index.ts (que não importa offline — usa `npm:`). Lida como texto sem comentários:
// um "Changes" do Lovable que volte o `.slice` ou solte o fail-closed tem que ficar vermelho aqui.
Deno.test("index.ts manda ao prompt só `entrada.texto` e falha antes de pagar quando excede", () => {
  const fonte = removerComentarios(Deno.readTextFileSync("supabase/functions/kb-extract-specs/index.ts"));
  assertEquals(/content_extracted\s*\.\s*(slice|substring|substr)\s*\(/.test(fonte), false, "recorte cru de content_extracted voltou");
  assertIncludes(fonte, "${entrada.texto}");
  const iExcede = fonte.indexOf("if (entrada.excede)");
  const iClaude = fonte.indexOf("client.messages.create(");
  assertEquals(iExcede > 0 && iClaude > iExcede, true, "o fail-closed tem que vir ANTES da chamada paga");
  assertIncludes(fonte, "!entrada.excede && existing?.status === \"ready\"");
});
