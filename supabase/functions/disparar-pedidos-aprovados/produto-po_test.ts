// Itens do IncluirPedCompra: a decomposição provada pelo portal (unitário sem IPI + IPI da linha) vira nValUnit +
// nValorIpi SÓ quando o pedido INTEIRO a tem e cada item ainda bate com o custo da linha; senão o PO sai como sempre
// (nValUnit = preco_unitario, SEM nValorIpi — IPI ausente nunca vira 0, e nunca PO misto).
// Rodar: deno test supabase/functions/disparar-pedidos-aprovados/
import { type ItemPo, montarProdutosIncluir } from "./produto-po.ts";

function assertEquals(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: esperado ${String(expected)}, veio ${String(actual)}`);
}
// Pedido #3091 (arquivo-ouro): WJOI.7585GL 1 × 242,25 + IPI 7,87 (3,25%) · FC.6902L5 2 × 213,435 + IPI 27,75 (6,5%),
// gravados pela RPC: valor_linha = round2(mercadoria) + IPI e preco_unitario = valor_linha ÷ qtde (custo com IPI).
const wjoi = (o: Partial<ItemPo> = {}): ItemPo => ({
  sku_codigo_omie: "8689743214", qtde_final: 1, preco_unitario: 250.12, valor_linha: 250.12,
  preco_unitario_sem_ipi_portal: 242.25, valor_ipi_portal: 7.87, ...o,
});
const fc = (o: Partial<ItemPo> = {}): ItemPo => ({
  sku_codigo_omie: "8689962883", qtde_final: 2, preco_unitario: 227.31, valor_linha: 454.62,
  preco_unitario_sem_ipi_portal: 213.435, valor_ipi_portal: 27.75, ...o,
});
const semDecomposicao = (o: Partial<ItemPo> = {}): ItemPo => ({
  sku_codigo_omie: "8689962883", qtde_final: 2, preco_unitario: 227.31, valor_linha: 454.62, ...o,
});
function assertPoDeHoje(itens: ItemPo[], decomposicao: string, msg: string) {
  const r = montarProdutosIncluir(itens);
  assertEquals(r.decomposicao, decomposicao, `${msg} — classificação`);
  r.produtos.forEach((p, i) => {
    assertEquals(p.nValUnit, Number(itens[i].preco_unitario), `${msg} — item ${i + 1} com o preco_unitario de hoje`);
    assertEquals("nValorIpi" in p, false, `${msg} — item ${i + 1} sem nValorIpi`);
  });
}

Deno.test("pedido inteiro decomposto e coerente (#3091): nValUnit sem IPI + nValorIpi da linha em todo item", () => {
  const r = montarProdutosIncluir([wjoi(), fc()]);
  assertEquals(r.decomposicao, "completa", "classificação");
  assertEquals(
    JSON.stringify(r.produtos),
    '[{"cCodIntItem":"ITEM001","nCodProd":8689743214,"nQtde":1,"nValUnit":242.25,"nValorIpi":7.87},' +
      '{"cCodIntItem":"ITEM002","nCodProd":8689962883,"nQtde":2,"nValUnit":213.435,"nValorIpi":27.75}]',
    "payload exato",
  );
});
Deno.test("sem decomposição em nenhum item: o PO de sempre — nValUnit = preco_unitario e a chave nValorIpi AUSENTE", () => {
  assertPoDeHoje([semDecomposicao(), semDecomposicao({ sku_codigo_omie: "8689743214" })], "ausente", "fornecedor sem portal");
  assertEquals(montarProdutosIncluir([semDecomposicao(), semDecomposicao()]).produtos[1].cCodIntItem, "ITEM002", "índice 1-based com 3 dígitos");
});
Deno.test("0% medido: nValorIpi 0 explícito (zero MEDIDO, não fabricado)", () => {
  const r = montarProdutosIncluir([wjoi({ preco_unitario: 13.71, valor_linha: 13.71, preco_unitario_sem_ipi_portal: 13.71, valor_ipi_portal: 0 })]);
  assertEquals(r.decomposicao, "completa", "classificação");
  assertEquals(r.produtos[0].nValUnit, 13.71, "unitário");
  assertEquals(r.produtos[0].nValorIpi, 0, "zero medido");
});
Deno.test("PostgREST devolve numeric como string: converte", () => {
  const r = montarProdutosIncluir([fc({ valor_linha: "454.62", preco_unitario_sem_ipi_portal: "213.435", valor_ipi_portal: "27.75" })]);
  assertEquals(r.decomposicao, "completa", "classificação");
  assertEquals(r.produtos[0].nValUnit, 213.435, "unitário da string");
  assertEquals(r.produtos[0].nValorIpi, 27.75, "IPI da string");
});
Deno.test("decomposição em parte dos itens ⇒ o PO de hoje para TODOS (nunca PO misto)", () => {
  assertPoDeHoje([wjoi(), semDecomposicao()], "parcial", "um item sem decomposição");
});
Deno.test("quantidade editada depois da captura (2 → 4) ⇒ decomposição velha, o PO de hoje para todos", () => {
  // O IPI gravado é o da LINHA de 2 unidades: 4 × 213,435 + 27,75 = 881,49 ≠ custo da linha — não escala.
  assertPoDeHoje([wjoi(), fc({ qtde_final: 4, valor_linha: 909.24 })], "incoerente", "qtde nova, linha recalculada");
  assertPoDeHoje([wjoi(), fc({ qtde_final: 4 })], "incoerente", "qtde nova, linha velha");
});
Deno.test("preço editado à mão depois da captura ⇒ vale o preço editado, sem nValorIpi", () => {
  assertPoDeHoje([wjoi(), fc({ preco_unitario: 240, valor_linha: 480 })], "incoerente", "preço novo");
});
Deno.test("decomposição inválida em qualquer item ⇒ o PO de hoje para todos, nunca nValorIpi fabricado", () => {
  const casos: Partial<ItemPo>[] = [
    { preco_unitario_sem_ipi_portal: null },
    { valor_ipi_portal: null },
    { preco_unitario_sem_ipi_portal: 0, valor_ipi_portal: 27.75 },
    { valor_ipi_portal: -0.01 },
    { preco_unitario_sem_ipi_portal: "abc" },
    { preco_unitario_sem_ipi_portal: Number.POSITIVE_INFINITY },
    { valor_ipi_portal: "" },
    { valor_ipi_portal: " " },
    { valor_linha: null },
    { valor_linha: " " },
  ];
  for (const c of casos) assertPoDeHoje([wjoi(), fc(c)], "incoerente", `inválido ${JSON.stringify(c)}`);
});
Deno.test("item a 0% com o IPI nulo ou em branco ⇒ não vira zero (a coerência fecharia: unitário × qtde = linha)", () => {
  const zero = { preco_unitario: 13.71, valor_linha: 13.71, preco_unitario_sem_ipi_portal: 13.71 };
  assertPoDeHoje([wjoi({ ...zero, valor_ipi_portal: null })], "incoerente", "IPI nulo");
  assertPoDeHoje([wjoi({ ...zero, valor_ipi_portal: " " })], "incoerente", "IPI em branco");
});
Deno.test("nQtde segue o backstop de quantidade inteira (ceil)", () => {
  assertEquals(montarProdutosIncluir([semDecomposicao({ qtde_final: 3.99996 })]).produtos[0].nQtde, 4, "ceil");
});
