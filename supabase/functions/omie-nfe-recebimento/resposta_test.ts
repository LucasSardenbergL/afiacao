// Testa o CÓDIGO REAL de resposta.ts no runtime real (Deno) — sem imports remotos (`--no-remote`).
// Roda com: bun run test:edges  (ou: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-nfe-recebimento/)
//
// Money-path: esta edge EFETIVA a NF-e no Omie. Antes (#M-01), TODA falha saía HTTP 200 com
// `success:false` — e um caller que só olhava o transporte (`if (res.error) throw`) comemorava
// "efetivada" sobre uma falha. O status HTTP passa a carregar o veredito: só `success === true` é 2xx.
import { statusHttpEfetivacao } from "./resposta.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(`${msg ?? "assertEquals"}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}

Deno.test("success:true (efetivado / reconciliado) → 200", () => {
  assertEquals(statusHttpEfetivacao({ success: true, modo: "efetivado" }), 200);
  assertEquals(statusHttpEfetivacao({ success: true, modo: "reconciliado" }), 200);
});

Deno.test("throttle (trégua transitória do Omie) → 429, para o caller distinguir 'tente de novo' de falha", () => {
  assertEquals(statusHttpEfetivacao({ success: false, modo: "throttle" }), 429);
});

Deno.test("falha_efetivacao e efetivacao_parcial → 502 (o ERP não efetivou)", () => {
  assertEquals(statusHttpEfetivacao({ success: false, modo: "falha_efetivacao" }), 502);
  assertEquals(statusHttpEfetivacao({ success: false, modo: "efetivacao_parcial" }), 502);
});

Deno.test("success ausente ou não-boolean NUNCA é 2xx (ausência de sinal ≠ aprovação)", () => {
  assertEquals(statusHttpEfetivacao({ modo: "efetivado" }), 502);
  assertEquals(statusHttpEfetivacao({ success: "true" as unknown as boolean, modo: "efetivado" }), 502);
});

Deno.test("throttle só é 429 quando NÃO houve sucesso (success:true manda)", () => {
  assertEquals(statusHttpEfetivacao({ success: true, modo: "throttle" }), 200);
});
