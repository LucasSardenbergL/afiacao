// Item do IncluirPedCompra: a decomposição provada pelo portal (unitário sem IPI + IPI da linha) vira nValUnit +
// nValorIpi; sem ela, o PO sai como sempre (nValUnit = preco_unitario, SEM nValorIpi — IPI ausente nunca vira 0).
// Rodar: deno test supabase/functions/disparar-pedidos-aprovados/
import { montarProdutoIncluir, type ItemPo } from "./produto-po.ts";

function assertEquals(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: esperado ${String(expected)}, veio ${String(actual)}`);
}
const base = (o: Partial<ItemPo> = {}): ItemPo => ({ sku_codigo_omie: "8689962883", qtde_final: 2, preco_unitario: 227.31, ...o });

Deno.test("com a decomposição (#3091, FC.6902L5): nValUnit sem IPI + nValorIpi da linha", () => {
  const p = montarProdutoIncluir(base({ preco_unitario_sem_ipi_portal: 213.435, valor_ipi_portal: 27.75 }), 0);
  assertEquals(JSON.stringify(p), '{"cCodIntItem":"ITEM001","nCodProd":8689962883,"nQtde":2,"nValUnit":213.435,"nValorIpi":27.75}', "payload exato");
});
Deno.test("sem decomposição: o PO de sempre — nValUnit = preco_unitario e a chave nValorIpi AUSENTE", () => {
  const p = montarProdutoIncluir(base(), 4);
  assertEquals(p.nValUnit, 227.31, "custo de hoje");
  assertEquals("nValorIpi" in p, false, "IPI ausente não vira 0");
  assertEquals(p.cCodIntItem, "ITEM005", "índice 1-based com 3 dígitos");
});
Deno.test("0% medido: nValorIpi 0 explícito (zero MEDIDO, não fabricado)", () => {
  const p = montarProdutoIncluir(base({ preco_unitario_sem_ipi_portal: 13.71, valor_ipi_portal: 0 }), 0);
  assertEquals(p.nValUnit, 13.71, "unitário");
  assertEquals(p.nValorIpi, 0, "zero medido");
});
Deno.test("PostgREST devolve numeric como string: converte", () => {
  const p = montarProdutoIncluir(base({ preco_unitario_sem_ipi_portal: "213.435", valor_ipi_portal: "27.75" }), 0);
  assertEquals(p.nValUnit, 213.435, "unitário da string");
  assertEquals(p.nValorIpi, 27.75, "IPI da string");
});
Deno.test("decomposição pela metade ou inválida ⇒ caminho de hoje, nunca nValorIpi fabricado", () => {
  const casos: Partial<ItemPo>[] = [
    { valor_ipi_portal: 27.75 },
    { preco_unitario_sem_ipi_portal: 213.435 },
    { preco_unitario_sem_ipi_portal: 0, valor_ipi_portal: 1 },
    { preco_unitario_sem_ipi_portal: 213.435, valor_ipi_portal: -0.01 },
    { preco_unitario_sem_ipi_portal: "abc", valor_ipi_portal: 1 },
    { preco_unitario_sem_ipi_portal: Number.POSITIVE_INFINITY, valor_ipi_portal: 1 },
    { preco_unitario_sem_ipi_portal: 213.435, valor_ipi_portal: "" },
  ];
  for (const c of casos) {
    const p = montarProdutoIncluir(base(c), 0);
    assertEquals(p.nValUnit, 227.31, `nValUnit de hoje (${JSON.stringify(c)})`);
    assertEquals("nValorIpi" in p, false, `sem nValorIpi (${JSON.stringify(c)})`);
  }
});
Deno.test("nQtde segue o backstop de quantidade inteira (ceil)", () => {
  assertEquals(montarProdutoIncluir(base({ qtde_final: 3.99996 }), 0).nQtde, 4, "ceil");
});
