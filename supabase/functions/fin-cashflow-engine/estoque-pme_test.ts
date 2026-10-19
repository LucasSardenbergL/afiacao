// deno test supabase/functions/fin-cashflow-engine/estoque-pme_test.ts
import { calcularPme, cmvTtmFechado, resolverEstoque } from "./estoque-pme.ts";

function assertEq(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEq"}: esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`);
  }
}
function assertTem(motivos: string[], trecho: string) {
  if (!motivos.some((m) => m.includes(trecho))) {
    throw new Error(`motivo com "${trecho}" ausente em ${JSON.stringify(motivos)}`);
  }
}

const HOJE = "2026-10-18";
const OMIE_OK = { valor_giro: 445476, skus_giro: 735, cobertura_pct: 100, valor_sem_classificacao: null };

Deno.test("resolverEstoque: manual de 10 dias vence o Omie", () => {
  const r = resolverEstoque({ valor: 500000, data_ref: "2026-10-08" }, OMIE_OK, HOJE);
  assertEq([r.valor, r.fonte, r.data_ref, r.cobertura_ok, r.motivos], [500000, "manual", "2026-10-08", true, []]);
});

Deno.test("resolverEstoque: manual de 46 dias perde para o Omie", () => {
  const r = resolverEstoque({ valor: 500000, data_ref: "2026-09-02" }, OMIE_OK, HOJE);
  assertEq([r.valor, r.fonte, r.data_ref], [445476, "omie", HOJE]);
});

Deno.test("resolverEstoque: manual com data_ref no futuro é ignorado", () => {
  const r = resolverEstoque({ valor: 1, data_ref: "2026-10-19" }, OMIE_OK, HOJE);
  assertEq(r.fonte, "omie");
});

Deno.test("resolverEstoque: Omie sem SKU de giro com custo → null, nunca 0", () => {
  const r = resolverEstoque(null, { valor_giro: null, skus_giro: 0, cobertura_pct: null, valor_sem_classificacao: 38175 }, HOJE);
  assertEq([r.valor, r.fonte, r.cobertura_ok], [null, null, false]);
  assertTem(r.motivos, "Estoque indispon");
});

Deno.test("resolverEstoque: sem nenhuma fonte → null + motivo", () => {
  const r = resolverEstoque(null, null, HOJE);
  assertEq([r.valor, r.fonte], [null, null]);
  assertTem(r.motivos, "Estoque indispon");
});

Deno.test("resolverEstoque: cobertura de custo < 95% preserva o valor mas não sustenta PME", () => {
  const r = resolverEstoque(null, { ...OMIE_OK, cobertura_pct: 90 }, HOJE);
  assertEq([r.valor, r.cobertura_ok], [445476, false]);
  assertTem(r.motivos, "sem custo");
});

Deno.test("resolverEstoque: estoque sem classificação vira motivo com o R$", () => {
  const r = resolverEstoque(null, { ...OMIE_OK, valor_sem_classificacao: 38175.48 }, HOJE);
  assertEq(r.cobertura_ok, true);
  assertTem(r.motivos, "sem tipo de item");
});

const meses = (de: [number, number], n: number, cmv = 1000) =>
  Array.from({ length: n }, (_, i) => {
    const idx = de[0] * 12 + (de[1] - 1) + i;
    return { ano: Math.floor(idx / 12), mes: (idx % 12) + 1, cmv };
  });

Deno.test("cmvTtmFechado: 12 meses fechados (out/25–set/26) somam", () => {
  assertEq(cmvTtmFechado(meses([2025, 10], 12), HOJE), { valor: 12000, motivo: null });
});

Deno.test("cmvTtmFechado: mês corrente (out/26) fica de fora", () => {
  assertEq(cmvTtmFechado(meses([2025, 10], 13), HOJE), { valor: 12000, motivo: null });
});

Deno.test("cmvTtmFechado: 6/12 meses → null com motivo", () => {
  const r = cmvTtmFechado(meses([2025, 10], 6), HOJE);
  assertEq(r.valor, null);
  assertTem([r.motivo ?? ""], "6/12");
});

Deno.test("cmvTtmFechado: 12 linhas com um mês duplicado e um faltando → null", () => {
  const l = meses([2025, 10], 12);
  l[11] = { ...l[10] };
  assertEq(cmvTtmFechado(l, HOJE).valor, null);
});

Deno.test("cmvTtmFechado: um cmv null → null", () => {
  const l: Array<{ ano: number; mes: number; cmv: number | null }> = meses([2025, 10], 12);
  l[3] = { ...l[3], cmv: null };
  assertEq(cmvTtmFechado(l, HOJE).valor, null);
});

Deno.test("cmvTtmFechado: todos zero → null 'zerado'", () => {
  const r = cmvTtmFechado(meses([2025, 10], 12, 0), HOJE);
  assertEq(r.valor, null);
  assertTem([r.motivo ?? ""], "zerado");
});

Deno.test("calcularPme: ausente em qualquer ponta ou cobertura ruim → null", () => {
  assertEq(calcularPme(null, 3650, true), null);
  assertEq(calcularPme(1000, null, true), null);
  assertEq(calcularPme(1000, 3650, false), null);
  assertEq(calcularPme(1000, 3650, true), 100);
});
