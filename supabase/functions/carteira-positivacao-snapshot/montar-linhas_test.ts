// Testa o CÓDIGO REAL de montar-linhas.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/carteira-positivacao-snapshot/montar-linhas_test.ts
//
// Por que este teste existe: até 2026-08 o snapshot mensal gravava 7 campos e NUNCA
// escrevia `contacted_in_month`/`visited_in_month` — as colunas ficavam no DEFAULT false
// nas 28.027 linhas de prod. O efeito não é "campo vazio": é que o par esforço→resultado
// (ligou/visitou × comprou) fica indistinguível de "ninguém ligou", então a pergunta que
// justifica a rota — "contatar converte?" — era irrespondível por construção.
import { montarLinhasSnapshot } from "./montar-linhas.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const MES = "2026-07-01";
const A = (customer_user_id: string, eligible = true) => ({
  customer_user_id,
  owner_user_id: "owner-1",
  eligible,
});

// ── o par esforço→resultado (o que o bug apagava) ──────────────────────────

Deno.test("contatado E comprou → as duas pontas verdadeiras (a conversão fica visível)", () => {
  const linhas = montarLinhasSnapshot(
    MES,
    [A("c1")],
    [{ customer_user_id: "c1", total: 100, order_date_kpi: "2026-07-10" }],
    new Set(["c1"]),
    new Set(),
  );
  assertEquals(linhas[0].contacted_in_month, true);
  assertEquals(linhas[0].had_order_in_month, true);
});

Deno.test("contatado e NÃO comprou → esforço registrado sem resultado (o denominador honesto)", () => {
  const linhas = montarLinhasSnapshot(MES, [A("c1")], [], new Set(["c1"]), new Set());
  assertEquals(linhas[0].contacted_in_month, true);
  assertEquals(linhas[0].had_order_in_month, false);
  assertEquals(linhas[0].revenue_month, 0);
});

Deno.test("comprou SEM contato → compra espontânea não vira crédito da rota", () => {
  const linhas = montarLinhasSnapshot(
    MES,
    [A("c1")],
    [{ customer_user_id: "c1", total: 100, order_date_kpi: "2026-07-10" }],
    new Set(),
    new Set(),
  );
  assertEquals(linhas[0].contacted_in_month, false);
  assertEquals(linhas[0].had_order_in_month, true);
});

Deno.test("visita é canal independente do contato telefônico", () => {
  const linhas = montarLinhasSnapshot(MES, [A("c1")], [], new Set(), new Set(["c1"]));
  assertEquals(linhas[0].visited_in_month, true);
  assertEquals(linhas[0].contacted_in_month, false);
});

Deno.test("sem esforço nenhum → false explícito, nunca null/undefined", () => {
  const linhas = montarLinhasSnapshot(MES, [A("c1")], [], new Set(), new Set());
  assertEquals(linhas[0].contacted_in_month, false);
  assertEquals(linhas[0].visited_in_month, false);
});

// ── agregação de pedidos (comportamento preservado do index.ts) ────────────

Deno.test("vários pedidos → receita somada e PRIMEIRA data do mês", () => {
  const linhas = montarLinhasSnapshot(
    MES,
    [A("c1")],
    [
      { customer_user_id: "c1", total: 100, order_date_kpi: "2026-07-20" },
      { customer_user_id: "c1", total: 50, order_date_kpi: "2026-07-03" },
    ],
    new Set(),
    new Set(),
  );
  assertEquals(linhas[0].revenue_month, 150);
  assertEquals(linhas[0].first_order_date_in_month, "2026-07-03");
});

Deno.test("total null não vira NaN (ausente ≠ zero só vale pro SINAL, soma degrada pra 0)", () => {
  const linhas = montarLinhasSnapshot(
    MES,
    [A("c1")],
    [{ customer_user_id: "c1", total: null, order_date_kpi: "2026-07-10" }],
    new Set(),
    new Set(),
  );
  assertEquals(linhas[0].revenue_month, 0);
  assertEquals(Number.isNaN(linhas[0].revenue_month), false);
});

Deno.test("sem pedido → data null (não fabrica data)", () => {
  const linhas = montarLinhasSnapshot(MES, [A("c1")], [], new Set(), new Set());
  assertEquals(linhas[0].first_order_date_in_month, null);
  assertEquals(linhas[0].had_order_in_month, false);
});

// ── escopo e formato ──────────────────────────────────────────────────────

Deno.test("uma linha por assignment, carimbada com o mês pedido", () => {
  const linhas = montarLinhasSnapshot(MES, [A("c1"), A("c2", false)], [], new Set(), new Set());
  assertEquals(linhas.length, 2);
  assertEquals(linhas[0].mes, MES);
  assertEquals(linhas[1].eligible, false);
});

Deno.test("esforço de quem NÃO está na carteira não inventa linha", () => {
  const linhas = montarLinhasSnapshot(MES, [A("c1")], [], new Set(["fantasma"]), new Set(["fantasma"]));
  assertEquals(linhas.length, 1);
  assertEquals(linhas[0].customer_user_id, "c1");
  assertEquals(linhas[0].contacted_in_month, false);
});
