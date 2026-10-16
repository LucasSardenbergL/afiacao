// `assertEquals` local em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
function assertEquals(atual: unknown, esperado: unknown) {
  const a = JSON.stringify(atual);
  const e = JSON.stringify(esperado);
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`);
}
import { dataBRparaISO, lerCabecalho, lerItens, lerPedidoPortal, mensagemErroImportacao, numeroBR, situacaoCancelada, situacaoPermitida } from "./leitura.ts";

// Resposta REAL do portal (pedido 2140603, 2026-10-14) — consulta e busca-itens-pedido.
const LINHA_REAL = {
  "Estab": "CAJ",
  "Pedido": "2140603",
  "Pedido Clien": "2140603",
  "Cliente": "OBEN COMERCIO LTDA",
  "Situação": "5 - Suspenso",
  "Data Emissão": "14/10/2026",
  "Data Entrega": "26/10/2026",
  "Vlr Mercadori": "4865,5600",
  "Vlr Total": "5181,8200",
};
const ITENS_REAL = {
  success: true,
  itens: [[10, "DFA.4080LT", "", "L", 18, 288, 16, 19.8637, 357.5466, 357.5466, 5, "14,9488", 4865.5584, "DILUENTE PU 4080A LT", "PROREAL", 30, "0.0000", "1.0000", "", 5]],
  data_pedido: { transportadora: "SPMINAS", cliente_remessa_triang: "", taxa_financiamento: 1, tabelaPreco: "PROREAL" },
};

Deno.test("pedido real 2140603: lê cabeçalho e item, total cobrado = Vlr Total", () => {
  const r = lerPedidoPortal([LINHA_REAL], ITENS_REAL, "2140603");
  if (!r.ok) throw new Error(`esperava ok, veio ${r.motivo}: ${r.detalhe}`);
  assertEquals(r.cabecalho, {
    protocolo: "2140603", cliente: "OBEN COMERCIO LTDA", situacao: "5 - Suspenso",
    data_entrega: "2026-10-26", valor_mercadoria: 4865.56, valor_total: 5181.82,
  });
  assertEquals(r.itens, [{ seq: 10, sku_portal: "DFA.4080LT", descricao: "DILUENTE PU 4080A LT", qtde_portal: 16, valor_mercadoria: 4865.5584 }]);
});

Deno.test("coluna Pedido é casada EXATA: 'Pedido Clien' com o nº não vale como o pedido", () => {
  const r = lerCabecalho([{ ...LINHA_REAL, "Pedido": "2140999", "Pedido Clien": "2140603" }], "2140603");
  assertEquals(r.ok ? "ok" : r.motivo, "nao_encontrado");
});

Deno.test("duas linhas com o mesmo nº (proposta + pedido) = ambíguo", () => {
  const r = lerCabecalho([LINHA_REAL, LINHA_REAL], "2140603");
  assertEquals(r.ok ? "ok" : r.motivo, "consulta_ambigua");
});

Deno.test("cliente que não é a OBEN é recusado", () => {
  const r = lerCabecalho([{ ...LINHA_REAL, "Cliente": "COLACOR COMERCIAL LTDA" }], "2140603");
  assertEquals(r.ok ? "ok" : r.motivo, "consulta_incompleta");
});

Deno.test("situação ausente é recusada (não dá para saber o que é a linha)", () => {
  const r = lerCabecalho([{ ...LINHA_REAL, "Situação": "" }], "2140603");
  assertEquals(r.ok ? "ok" : r.motivo, "consulta_incompleta");
});

Deno.test("Vlr Total ilegível: ausente ≠ zero, recusa", () => {
  const r = lerCabecalho([{ ...LINHA_REAL, "Vlr Total": "" }], "2140603");
  assertEquals(r.ok ? "ok" : r.motivo, "consulta_incompleta");
});

Deno.test("itens: success falso ou lista vazia = itens_ausentes", () => {
  assertEquals((r => r.ok ? "ok" : r.motivo)(lerItens({ success: false, itens: ITENS_REAL.itens })), "itens_ausentes");
  assertEquals((r => r.ok ? "ok" : r.motivo)(lerItens({ success: true, itens: [] })), "itens_ausentes");
  assertEquals((r => r.ok ? "ok" : r.motivo)(lerItens(null)), "itens_ausentes");
});

Deno.test("portal reordenou colunas (qtd UN no lugar da qtd fat) = item_incoerente, não importa número errado", () => {
  const trocado = [...ITENS_REAL.itens[0]];
  [trocado[5], trocado[6]] = [trocado[6], trocado[5]];
  assertEquals((r => r.ok ? "ok" : r.motivo)(lerItens({ success: true, itens: [trocado] })), "item_incoerente");
});

Deno.test("Preço Venda que não fecha com Preço UN × qtd × (1 − desc) = item_incoerente", () => {
  const alterado = [...ITENS_REAL.itens[0]];
  alterado[12] = 4900;
  assertEquals((r => r.ok ? "ok" : r.motivo)(lerItens({ success: true, itens: [alterado] })), "item_incoerente");
});

Deno.test("quantidade fracionária de embalagem = item_malformado", () => {
  const frac = [...ITENS_REAL.itens[0]];
  frac[6] = 16.5; frac[5] = 18 * 16.5;
  assertEquals((r => r.ok ? "ok" : r.motivo)(lerItens({ success: true, itens: [frac] })), "item_malformado");
});

Deno.test("item que falta na leitura: Σ linhas ≠ Vlr Mercadoria da consulta", () => {
  const r = lerPedidoPortal([{ ...LINHA_REAL, "Vlr Mercadori": "9731,1200" }], ITENS_REAL, "2140603");
  assertEquals(r.ok ? "ok" : r.motivo, "mercadoria_diverge_da_consulta");
});

Deno.test("numeroBR e dataBRparaISO", () => {
  assertEquals(numeroBR("4.865,5600"), 4865.56);
  assertEquals(numeroBR("4865.5584"), 4865.5584);
  assertEquals(numeroBR(""), null);
  assertEquals(numeroBR("R$ 10"), null);
  assertEquals(dataBRparaISO("26/10/2026"), "2026-10-26");
  assertEquals(dataBRparaISO("31/02/2026"), null);
  assertEquals(dataBRparaISO("2026-10-26"), null);
});

Deno.test("mensagem de erro por SQLSTATE; desconhecida não inventa motivo", () => {
  assertEquals(mensagemErroImportacao("IP002", null).startsWith("Há item sem de-para"), true);
  assertEquals(mensagemErroImportacao("XX999", "boom"), "Falha ao gravar a importação. Detalhe: boom");
});

Deno.test("pedido cancelado no portal (6 - Cancelado) é recusado na leitura, com motivo próprio", () => {
  const r = lerPedidoPortal([{ ...LINHA_REAL, "Situação": "6 - Cancelado" }], ITENS_REAL, "2140603");
  assertEquals(r.ok ? "ok" : r.motivo, "pedido_cancelado");
  if (!r.ok && !r.detalhe.includes("cancelado no portal")) throw new Error(`detalhe sem o motivo: ${r.detalhe}`);
});

Deno.test("situacaoCancelada: código 6 ou o texto; as outras situações passam", () => {
  assertEquals(
    ["6 - Cancelado", "6 -", "Cancelado", "CANCELADA", "5 - Suspenso", "1 - Aberto", "16 - Outro", "4 - Faturado"].map(situacaoCancelada),
    [true, true, true, true, false, false, false, false],
  );
});

Deno.test("situacaoPermitida: só código da lista; sem código ou lista vazia = não", () => {
  assertEquals(
    [situacaoPermitida("1 - Aberto", ["1"]), situacaoPermitida("4 - Faturado", ["1"]), situacaoPermitida("Aberto", ["1"]),
     situacaoPermitida("1 - Aberto", []), situacaoPermitida("11 - Outro", ["1"])],
    [true, false, false, false, false],
  );
});
