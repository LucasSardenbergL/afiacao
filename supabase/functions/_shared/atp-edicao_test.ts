// Testa o CÓDIGO REAL de atp-edicao.ts (delta de exposição Oben na edição)
// no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/atp-edicao_test.ts

import { deltaEdicaoOben } from "./atp-edicao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

Deno.test("aumento de quantidade do mesmo SKU → aumentou com delta", () => {
  const r = deltaEdicaoOben(
    [{ omie_codigo_produto: 111, quantidade: 2 }],
    [{ omie_codigo_produto: 111, quantidade: 5 }],
  );
  assertEquals(r.aumentou, true);
  assertEquals(r.aumentos, [{ omie_codigo_produto: 111, quantidade_atual: 2, quantidade_nova: 5 }]);
});

Deno.test("SKU novo na edição → aumentou (quantidade_atual 0)", () => {
  const r = deltaEdicaoOben(
    [{ omie_codigo_produto: 111, quantidade: 2 }],
    [{ omie_codigo_produto: 111, quantidade: 2 }, { omie_codigo_produto: 222, quantidade: 1 }],
  );
  assertEquals(r.aumentou, true);
  assertEquals(r.aumentos, [{ omie_codigo_produto: 222, quantidade_atual: 0, quantidade_nova: 1 }]);
});

Deno.test("redução e remoção NÃO aumentam (liberar exposição sempre passa)", () => {
  const r = deltaEdicaoOben(
    [{ omie_codigo_produto: 111, quantidade: 5 }, { omie_codigo_produto: 222, quantidade: 1 }],
    [{ omie_codigo_produto: 111, quantidade: 2 }],
  );
  assertEquals(r.aumentou, false);
  assertEquals(r.aumentos, []);
});

Deno.test("mesmos itens (retry sem mudança) → não aumenta", () => {
  const itens = [{ omie_codigo_produto: 111, quantidade: 2 }];
  assertEquals(deltaEdicaoOben(itens, itens).aumentou, false);
});

Deno.test("itens duplicados do mesmo SKU AGREGAM antes de comparar", () => {
  const r = deltaEdicaoOben(
    [{ omie_codigo_produto: 111, quantidade: 5 }],
    [{ omie_codigo_produto: 111, quantidade: 2 }, { omie_codigo_produto: 111, quantidade: 3 }],
  );
  assertEquals(r.aumentou, false, "2+3=5 agregado não é aumento");
});

Deno.test("quantidade em string numérica (jsonb round-trip) compara certo", () => {
  const r = deltaEdicaoOben(
    [{ omie_codigo_produto: "111", quantidade: "2" }],
    [{ omie_codigo_produto: 111, quantidade: 3 }],
  );
  assertEquals(r.aumentou, true);
  assertEquals(r.aumentos[0].quantidade_atual, 2);
});

Deno.test("item ilegível (sku/qtd inválidos) é contado, não fabricado", () => {
  const r = deltaEdicaoOben(
    [{ omie_codigo_produto: null, quantidade: 2 }, { omie_codigo_produto: 111, quantidade: 0 }],
    [{ omie_codigo_produto: 111, quantidade: 1 }],
  );
  assertEquals(r.ilegiveis, 2);
  assertEquals(r.aumentou, true, "111 atual ilegível (qtd 0) não conta como 0→1? conta: atual só tem ilegíveis");
});

Deno.test("listas vazias/nulas → sem aumento, sem crash", () => {
  assertEquals(deltaEdicaoOben(null, undefined).aumentou, false);
  assertEquals(deltaEdicaoOben([], []).aumentou, false);
});
