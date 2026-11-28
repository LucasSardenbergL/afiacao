// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/fin-suggest-mapping/
// Assert local: `test:edges` roda com `--no-remote`.
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`);
  }
}
import { decidirSugestaoCruzada, mapeamentosComMesmaDescricao, normalizarDescricao } from "./sugestao-cruzada.ts";

const desc: Record<string, string> = {
  "colacor|2.01.99": "Compra de Ativo Imobilizado",
  "colacor_sc|2.01.99": "Compra de Material Uso e Consumo",
  "colacor|2.03.05": "13 Salário",
  "colacor|1.01.01": "Venda de Mercadorias Fabricadas",
};
const de = (c: string, k: string) => desc[`${c}|${k}`];

Deno.test("normalizar: caixa, acento, pontuação e espaço", () => {
  assertEquals(normalizarDescricao("  13º  Salário "), "13 salario");
  assertEquals(normalizarDescricao("13 Salario"), "13 salario");
  assertEquals(normalizarDescricao(""), null);
  assertEquals(normalizarDescricao(null), null);
  assertEquals(normalizarDescricao("—"), null);
});

Deno.test("mesmo código com descrição DIFERENTE não sugere (2.01.99 colacor ≠ oben)", () => {
  const r = mapeamentosComMesmaDescricao(
    "Compra de Material de Uso e Consumo",
    [{ company: "colacor", dre_linha: "nao_resultado" }, { company: "colacor_sc", dre_linha: "despesas_administrativas" }],
    "2.01.99",
    de,
  );
  // "Material Uso e Consumo" (sem "de") também é outra string: precisão > recall.
  assertEquals(r, []);
});

Deno.test("descrição igual a menos de forma sugere", () => {
  const r = mapeamentosComMesmaDescricao("13º salario", [{ company: "colacor", dre_linha: "despesas_administrativas" }], "2.03.05", de);
  assertEquals(r, [{ company: "colacor", dre_linha: "despesas_administrativas" }]);
});

Deno.test("plural não é forma: Mercadoria ≠ Mercadorias", () => {
  const r = mapeamentosComMesmaDescricao("Venda de Mercadoria Fabricadas", [{ company: "colacor", dre_linha: "receita_bruta" }], "1.01.01", de);
  assertEquals(r, []);
});

Deno.test("descrição ausente (fonte ou alvo) ⇒ nada", () => {
  assertEquals(mapeamentosComMesmaDescricao(null, [{ company: "colacor", dre_linha: "cmv" }], "2.03.05", de), []);
  assertEquals(mapeamentosComMesmaDescricao("Qualquer", [{ company: "oben", dre_linha: "cmv" }], "9.99", de), []);
});

Deno.test("fontes com mesma descrição mas linhas DIFERENTES ⇒ sem sugestão (nada de sorteio)", () => {
  const d2 = (c: string, _k: string) => (c === "colacor" || c === "oben" ? "Outros" : undefined);
  assertEquals(
    decidirSugestaoCruzada("Outros", [{ company: "colacor", dre_linha: "despesas_administrativas" }, { company: "oben", dre_linha: "outras_despesas" }], "2.99", d2, () => true),
    null,
  );
  assertEquals(
    decidirSugestaoCruzada("Outros", [{ company: "colacor", dre_linha: "outras_despesas" }, { company: "oben", dre_linha: "outras_despesas" }], "2.99", d2, () => true),
    { company: "colacor", dre_linha: "outras_despesas" },
  );
});

Deno.test("divergência com fonte NÃO sugerível ainda conta (filtro só depois do desempate)", () => {
  const d2 = (c: string, _k: string) => (c === "colacor" || c === "colacor_sc" ? "Outros" : undefined);
  const naoFora = (l: string) => l !== "fora_dre" && l !== "nao_resultado";
  assertEquals(
    decidirSugestaoCruzada("Outros", [{ company: "colacor_sc", dre_linha: "despesas_administrativas" }, { company: "colacor", dre_linha: "fora_dre" }], "2.99", d2, naoFora),
    null,
  );
  assertEquals(decidirSugestaoCruzada("Outros", [{ company: "colacor", dre_linha: "fora_dre" }], "2.99", d2, naoFora), null);
});
