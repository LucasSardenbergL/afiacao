// Testa o CÓDIGO REAL de `fetchAll` (não uma cópia) no runtime real (Deno).
// Roda com: deno test supabase/functions/_shared/paginate_test.ts
import { fetchAll } from "./paginate.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

// "Banco" fake de N linhas; o build() pagina por .range() como o PostgREST faria,
// mas SEM o cap de 1000 (assim provamos que fetchAll busca a cauda inteira).
function fakeTable(total: number) {
  const all = Array.from({ length: total }, (_, i) => ({ id: i }));
  let calls = 0;
  const build = (from: number, to: number) => {
    calls++;
    return Promise.resolve({ data: all.slice(from, to + 1), error: null });
  };
  return { build, calls: () => calls };
}

Deno.test("abaixo do cap: retorna tudo em 1 request (estado real hoje: 292 linhas)", async () => {
  const t = fakeTable(292);
  const rows = await fetchAll<{ id: number }>(t.build, "t");
  assertEquals(rows.length, 292);
  assertEquals(t.calls(), 1);
});

Deno.test("ACIMA do cap (o bug): retorna a cauda inteira, não trunca em 1000", async () => {
  const t = fakeTable(2300);
  const rows = await fetchAll<{ id: number }>(t.build, "t");
  assertEquals(rows.length, 2300); // sem paginação, o PostgREST devolveria só 1000
  assertEquals((rows[2299] as { id: number }).id, 2299);
  assertEquals(t.calls(), 3); // 1000 + 1000 + 300
});

Deno.test("exatamente no cap: 1 request extra vazio, sem perder nem duplicar", async () => {
  const t = fakeTable(1000);
  const rows = await fetchAll<{ id: number }>(t.build, "t");
  assertEquals(rows.length, 1000);
  assertEquals(t.calls(), 2); // 2ª página volta vazia → para
});

Deno.test("dois caps cheios + resto: 2001 linhas em 3 requests", async () => {
  const t = fakeTable(2001);
  const rows = await fetchAll<{ id: number }>(t.build, "t");
  assertEquals(rows.length, 2001);
  assertEquals(t.calls(), 3);
});

Deno.test("tabela vazia: 1 request, zero linhas", async () => {
  const t = fakeTable(0);
  const rows = await fetchAll<{ id: number }>(t.build, "t");
  assertEquals(rows.length, 0);
  assertEquals(t.calls(), 1);
});

Deno.test("erro: lança com o label prefixado", async () => {
  let threw = false;
  try {
    await fetchAll(
      (_f, _t) => Promise.resolve({ data: null, error: { message: "boom" } }),
      "minha_tabela",
    );
  } catch (e) {
    threw = true;
    assertEquals((e as Error).message, "minha_tabela: boom");
  }
  assertEquals(threw, true);
});
