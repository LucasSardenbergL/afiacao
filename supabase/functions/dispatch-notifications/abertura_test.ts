// Régua do pixel de abertura do resumo de venda (venda R2, 2026-11-12). Roda:
//   deno test supabase/functions/dispatch-notifications/abertura_test.ts
import { CABECALHOS_PIXEL, PIXEL_GIF, tokenDeAbertura, urlDoPixel } from "./abertura.ts";

function eq(a: unknown, b: unknown, msg: string) {
  const sa = JSON.stringify(a) ?? "<undefined>";
  const sb = JSON.stringify(b) ?? "<undefined>";
  if (sa !== sb) throw new Error(`${msg}: ${sa} !== ${sb}`);
}

const TOKEN = "3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a5b";
const BASE = "https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/dispatch-notifications";

Deno.test("só GET com abertura = uuid é pixel; o resto segue para o gate autenticado", () => {
  eq(tokenDeAbertura("GET", `${BASE}?abertura=${TOKEN}`), TOKEN, "GET com uuid");
  eq(tokenDeAbertura("GET", `${BASE}?abertura=${TOKEN.toUpperCase()}`), TOKEN, "maiúsculas normalizam");
  eq(tokenDeAbertura("POST", `${BASE}?abertura=${TOKEN}`), null, "POST nunca é pixel (é o dispatch)");
  eq(tokenDeAbertura("GET", BASE), null, "GET sem token");
  eq(tokenDeAbertura("GET", `${BASE}?abertura=1;DROP`), null, "token fora da forma");
  eq(tokenDeAbertura("GET", `${BASE}?abertura=${TOKEN}x`), null, "uuid com sobra");
  eq(tokenDeAbertura("GET", "não é url"), null, "url inválida");
});

Deno.test("url do pixel: base https + token uuid; qualquer outra coisa → sem pixel", () => {
  eq(urlDoPixel("https://fzvklzpomgnyikkfkzai.supabase.co/", TOKEN), `${BASE}?abertura=${TOKEN}`, "url montada");
  eq(urlDoPixel("https://fzvklzpomgnyikkfkzai.supabase.co", null), null, "sem token");
  eq(urlDoPixel("http://inseguro.test", TOKEN), null, "base http");
  eq(urlDoPixel("https://x.test/caminho", TOKEN), null, "base com caminho");
});

Deno.test("o GIF é 1×1 válido e nunca entra em cache", () => {
  eq(new TextDecoder().decode(PIXEL_GIF.slice(0, 6)), "GIF89a", "assinatura GIF");
  eq(PIXEL_GIF.length, 42, "42 bytes");
  eq(CABECALHOS_PIXEL["Content-Type"], "image/gif", "content-type");
  eq(/no-store/.test(CABECALHOS_PIXEL["Cache-Control"]), true, "no-store");
});
