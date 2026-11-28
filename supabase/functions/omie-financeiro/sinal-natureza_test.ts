// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-financeiro/
import { acumularComposicaoCmv, novaComposicaoCmv, valorComSinal } from "./sinal-natureza.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`);
  }
}

Deno.test("mesmo lado da natureza soma", () => {
  assertEquals(valorComSinal(100, false, "cmv"), 100);
  assertEquals(valorComSinal(100, false, "despesas_administrativas"), 100);
  assertEquals(valorComSinal(100, false, "deducoes"), 100);
  assertEquals(valorComSinal(100, false, "ded_icms"), 100);
  assertEquals(valorComSinal(100, true, "receita_bruta"), 100);
  assertEquals(valorComSinal(100, true, "outras_receitas"), 100);
  assertEquals(valorComSinal(100, true, "receitas_financeiras"), 100);
});

Deno.test("lado oposto SUBTRAI: devolução de compra (CR em cmv) e estorno (CP em receita)", () => {
  assertEquals(valorComSinal(100, true, "cmv"), -100);
  assertEquals(valorComSinal(100, true, "despesas_financeiras"), -100);
  assertEquals(valorComSinal(100, false, "receita_bruta"), -100);
  assertEquals(valorComSinal(100, false, "outras_receitas"), -100);
});

Deno.test("composição do CMV: líquido = compras − devoluções, versionada", () => {
  const c = novaComposicaoCmv();
  acumularComposicaoCmv(c, 1000, false);
  acumularComposicaoCmv(c, 191, true);
  acumularComposicaoCmv(c, 9, true);
  assertEquals(c, { versao: "cmv-v1", compras: 1000, devolucoes_compra: 200, liquido: 800 });
});

Deno.test("mês só com devolução: CMV líquido negativo é honesto (não vira 0)", () => {
  const c = novaComposicaoCmv();
  acumularComposicaoCmv(c, 50, true);
  assertEquals(c.liquido, -50);
});
