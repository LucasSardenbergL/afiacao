// Testa o CÓDIGO REAL de linha-fluxo.ts no runtime Deno (sem import remoto).
import { criarResolverLinhaFluxo } from "./linha-fluxo.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
  }
}

Deno.test("código no mapa ⇒ linha curada; fora ⇒ nao_classificado; ausente ⇒ null", () => {
  const r = criarResolverLinhaFluxo([
    { omie_codigo: "2.01.01", fluxo_linha: "op_fornecedores" },
    { omie_codigo: "2.07.02", fluxo_linha: "fin_juros" },
  ]);
  assertEquals(r("2.01.01"), "op_fornecedores");
  assertEquals(r("2.07.02"), "fin_juros");
  assertEquals(r(" 2.07.02 "), "nao_classificado", "comparação exata, como PCO e DFC (sem aparo assimétrico)");
  assertEquals(r("   "), null, "só espaços é ausente");
  assertEquals(r("9.99.99"), "nao_classificado");
  assertEquals(r(null), null);
  assertEquals(r(undefined), null);
  assertEquals(r(""), null, "vazio é ausente, não 'nao_classificado'");
});

Deno.test("mapa vazio: todo código vira nao_classificado, ausente segue null", () => {
  const r = criarResolverLinhaFluxo([]);
  assertEquals(r("2.01.01"), "nao_classificado");
  assertEquals(r(null), null);
});
