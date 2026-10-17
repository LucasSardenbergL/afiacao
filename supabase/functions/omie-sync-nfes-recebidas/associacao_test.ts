// Testa o CÓDIGO REAL de associacao.ts (classificador da associação NF↔PO em sombra) no runtime Deno.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-sync-nfes-recebidas/associacao_test.ts
//
// Cada caso falsifica uma regra do desenho (decisões do founder 2026-10-16 + parecer Codex): total × parcial, casamento
// pelo contrato DO item, conservação do saldo agregado, quantidade exata, humanos (órfã, contrato em 2+ POs, composto,
// WP), estado da NF ≠ vínculo ≠ elegibilidade, e ausência nunca vira dado.
import { classificarAssociacao, type EntradaClassificador, type ItemPO, type PedidoDoContrato } from "./associacao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg ? `${msg}: ` : ""}esperado ${jb}, veio ${ja}`);
}

const SAYERLACK = 8689681266;
// Formato MEDIDO em 84 detalhes reais (psql-ro 2026-10-17): flags da NF em infoCadastro; pendente = cEtapa "40";
// no item pendente o Omie OMITE nIdItPedido e cItemDevolvido; cDevolvidoParc só aparece se houve devolução.
const cabecPendente = { cEtapa: "40", nIdReceb: 12196962110 };
const infoPendente = { cCancelada: "N", cRecebido: "N", cDevolvido: "N", cFaturado: "S" };

function item(seq: number, produto: number, qtd: unknown, contrato: unknown, extra: Record<string, unknown> = {}) {
  return {
    itensCabec: { nSequencia: seq, nIdProduto: produto, cIgnorarItem: "N", nIdItem: 0, ...(extra.cab ?? {}) },
    itensAjustes: { nQtdeRecebida: qtd, cUnidade: "GL", cNaoGerarMovEstoque: "N", ...(extra.aj ?? {}) },
    itensInfoAdic: contrato === undefined ? {} : { nNumPedCompra: contrato },
  };
}
const ip = (nCodItem: number, nCodProd: number, nQtde: unknown, extra: Partial<ItemPO> = {}): ItemPO =>
  ({ nCodItem, nCodProd, nQtde, cUnidade: "GL", ...extra });
const po = (id: number, numero: string, itens: ItemPO[] | undefined, forn = SAYERLACK, etapa: string | null = "15"): PedidoDoContrato =>
  ({ omie_codigo_pedido: id, numero_pedido: numero, fornecedor_codigo_omie: forn, etapa, itens });

type Over = Partial<EntradaClassificador> & { cabec?: Record<string, unknown>; info?: Record<string, unknown> };
function entrada(itens: unknown[], pedidos: Record<string, PedidoDoContrato[]> | null, over: Over = {}): EntradaClassificador {
  return {
    detalhe: { cabec: over.cabec ?? cabecPendente, infoCadastro: over.info ?? infoPendente, itensRecebimento: itens },
    fornecedor_codigo_omie: over.fornecedor_codigo_omie === undefined ? SAYERLACK : over.fornecedor_codigo_omie,
    pedidosPorContrato: pedidos === null ? null : new Map(Object.entries(pedidos)),
    skusComEquivalencia: over.skusComEquivalencia === undefined ? new Set<string>() : over.skusComEquivalencia,
  };
}

Deno.test("total: o único item do PO chega inteiro → associável, par exato, cobertura total", () => {
  const c = classificarAssociacao(entrada([item(1, 501, "2", "2132614")], { "2132614": [po(9001, "1244", [ip(77, 501, 2)])] }));
  assertEquals(c.classe, "associavel", "classe");
  assertEquals(c.motivos, [], "sem motivo");
  assertEquals(c.pares, [{ nSequencia: 1, nIdPedido: 9001, nIdItPedido: 77, quantidade: 2, unidade: "GL" }], "par");
  assertEquals(c.pedidos, [{ nIdPedido: 9001, numero_pedido: "1244", cobertura: "total" }], "total");
});

Deno.test("parcial: PO de 2 itens, a NF traz só 1 (inteiro) → associável, cobertura parcial", () => {
  const c = classificarAssociacao(entrada([item(1, 501, 2, "C1")], { C1: [po(9001, "1244", [ip(77, 501, 2), ip(78, 502, 5)])] }));
  assertEquals([c.classe, c.pedidos[0]?.cobertura], ["associavel", "parcial"]);
});

Deno.test("NF com 2 contratos, cada um com seu PO → associável nos dois", () => {
  const c = classificarAssociacao(entrada(
    [item(1, 501, 2, "C1"), item(2, 601, 1, "C2")],
    { C1: [po(9001, "1244", [ip(77, 501, 2)])], C2: [po(9002, "1248", [ip(88, 601, 1), ip(89, 602, 1)])] },
  ));
  assertEquals(c.classe, "associavel");
  assertEquals(c.pedidos.map((p) => p.cobertura), ["total", "parcial"]);
});

Deno.test("casamento pelo contrato DO item: produto que só existe no PO do outro contrato não casa", () => {
  const c = classificarAssociacao(entrada(
    [item(1, 601, 1, "C1"), item(2, 501, 2, "C2")],
    { C1: [po(9001, "1244", [ip(77, 501, 2)])], C2: [po(9002, "1248", [ip(88, 601, 1)])] },
  ));
  assertEquals([c.classe, c.motivos, c.pares], ["ambigua", ["item_sem_par"], []]);
});

Deno.test("conservação do saldo agregado: 6+6 num saldo de 10 é excesso; 6+4 fecha", () => {
  const pedidos = { C1: [po(9001, "1244", [ip(77, 501, 10)])] };
  const excesso = classificarAssociacao(entrada([item(1, 501, 6, "C1"), item(2, 501, 6, "C1")], pedidos));
  assertEquals([excesso.classe, excesso.motivos], ["ambigua", ["excesso_sobre_saldo"]]);
  const fecha = classificarAssociacao(entrada([item(1, 501, 6, "C1"), item(2, 501, 4, "C1")], pedidos));
  assertEquals([fecha.classe, fecha.pedidos[0]?.cobertura, fecha.pares.length], ["associavel", "total", 2]);
});

Deno.test("quantidade exata: menor que o saldo é ambígua; recebido anterior desconta; decimal sem erro de float", () => {
  const menor = classificarAssociacao(entrada([item(1, 501, 3, "C1")], { C1: [po(9001, "1", [ip(77, 501, 4)])] }));
  assertEquals(menor.motivos, ["quantidade_menor_que_saldo"]);
  const resto = classificarAssociacao(entrada([item(1, 501, 3, "C1")], { C1: [po(9001, "1", [ip(77, 501, 4, { nQtdeRec: 1 })])] }));
  assertEquals([resto.classe, resto.pedidos[0]?.cobertura], ["associavel", "total"]);
  const dec = classificarAssociacao(entrada([item(1, 501, "0.1", "C1"), item(2, 501, 0.2, "C1")], { C1: [po(9001, "1", [ip(77, 501, "0.3")])] }));
  assertEquals([dec.classe, dec.pedidos[0]?.cobertura], ["associavel", "total"]);
});

Deno.test("humanos: contrato em 2 POs, contrato composto, PO de outro fornecedor, órfã", () => {
  const dois = classificarAssociacao(entrada([item(1, 501, 2, "C1")], { C1: [po(1, "a", [ip(7, 501, 2)]), po(2, "b", [ip(8, 501, 2)])] }));
  assertEquals([dois.classe, dois.motivos], ["ambigua", ["contrato_em_varios_pos"]]);
  const comp = classificarAssociacao(entrada([item(1, 501, 2, "2138/2139")], {}));
  assertEquals(comp.motivos, ["contrato_composto"]);
  const outro = classificarAssociacao(entrada([item(1, 501, 2, "C1")], { C1: [po(1, "a", [ip(7, 501, 2)], 1111)] }));
  assertEquals(outro.motivos, ["contrato_sem_po"]);
  const orfa = classificarAssociacao(entrada([item(1, 501, 2, undefined), item(2, 502, 1, "0")], {}));
  assertEquals([orfa.classe, orfa.motivos], ["orfa", ["item_sem_contrato"]]);
  const meia = classificarAssociacao(entrada([item(1, 501, 2, "C1"), item(2, 502, 1, undefined)], { C1: [po(1, "a", [ip(7, 501, 2)])] }));
  assertEquals([meia.classe, meia.motivos], ["ambigua", ["item_sem_contrato"]]);
});

Deno.test("estado da NF: concluída e cancelada ficam fora de alcance; flag ausente é ilegível, nunca 'N'", () => {
  const pedidos = { C1: [po(9001, "1", [ip(77, 501, 2)])] };
  const conc = classificarAssociacao(entrada([item(1, 501, 2, "C1")], pedidos, { cabec: { cEtapa: "80" }, info: { ...infoPendente, cRecebido: "S" } }));
  assertEquals([conc.estado_nf, conc.classe, conc.pares], ["concluida", "fora_de_alcance", []]);
  const canc = classificarAssociacao(entrada([item(1, 501, 2, "C1")], pedidos, { info: { ...infoPendente, cCancelada: "S" } }));
  assertEquals([canc.estado_nf, canc.classe], ["cancelada", "fora_de_alcance"]);
  const sem = classificarAssociacao(entrada([item(1, 501, 2, "C1")], pedidos, { info: { cCancelada: "N" } }));
  assertEquals([sem.estado_nf, sem.classe, sem.motivos.includes("devolucao_ilegivel")], ["ilegivel", "fora_de_alcance", true]);
  const vazia = classificarAssociacao(entrada([item(1, 501, 2, "C1")], pedidos, { info: { ...infoPendente, cRecebido: "" } }));
  assertEquals([vazia.estado_nf, vazia.classe], ["ilegivel", "fora_de_alcance"], "flag em branco não vira 'N'");
  const etapa = classificarAssociacao(entrada([item(1, 501, 2, "C1")], pedidos, { cabec: { cEtapa: "50" } }));
  assertEquals([etapa.estado_nf, etapa.classe], ["ilegivel", "fora_de_alcance"], "N fora da etapa 40 não é pendente medido");
  // Regressão Codex 2026-10-17 P1: flags no cabec (formato que a API NÃO usa) não podem ser lidas como estado.
  const errado = classificarAssociacao({ ...entrada([item(1, 501, 2, "C1")], pedidos), detalhe: { cabec: { ...cabecPendente, ...infoPendente }, itensRecebimento: [item(1, 501, 2, "C1")] } });
  assertEquals([errado.estado_nf, errado.classe], ["ilegivel", "fora_de_alcance"]);
});

Deno.test("devolução: cDevolvidoParc/cItemDevolvido ausentes = sem devolução (medido); presentes e tortos = ilegível", () => {
  const p = { C1: [po(9001, "1", [ip(77, 501, 2)])] };
  assertEquals(classificarAssociacao(entrada([item(1, 501, 2, "C1")], p, { info: { ...infoPendente, cDevolvidoParc: "S" } })).motivos, ["nf_devolvida"]);
  assertEquals(classificarAssociacao(entrada([item(1, 501, 2, "C1")], p, { info: { ...infoPendente, cDevolvidoParc: "" } })).motivos, ["devolucao_ilegivel"]);
  assertEquals(classificarAssociacao(entrada([item(1, 501, 2, "C1", { cab: { cItemDevolvido: "?" } })], p)).motivos, ["devolucao_ilegivel"]);
  assertEquals(classificarAssociacao(entrada([item(1, 501, 2, "C1", { cab: { cItemDevolvido: "N" } })], p)).classe, "associavel");
});

Deno.test("vínculo: ausente ou 0 = sem vínculo; null/texto/negativo = ilegível; nIdPedido sem item = vinculada", () => {
  const p = { C1: [po(9001, "1", [ip(77, 501, 2)])] };
  assertEquals(classificarAssociacao(entrada([item(1, 501, 2, "C1", { cab: { nIdItPedido: 0 } })], p)).classe, "associavel", "0 explícito");
  for (const v of [null, "abc", -1, 1.5, ""]) {
    const c = classificarAssociacao(entrada([item(1, 501, 2, "C1", { cab: { nIdItPedido: v } })], p));
    assertEquals([c.classe, c.motivos], ["ambigua", ["vinculo_ilegivel"]], `nIdItPedido=${JSON.stringify(v)}`);
  }
  const cab = classificarAssociacao(entrada([item(1, 501, 2, "C1", { cab: { nIdPedido: 9999, nIdItPedido: 0 } })], p));
  assertEquals([cab.vinculo, cab.classe, cab.pares], ["completo", "ja_vinculada", []]);
});

Deno.test("PO candidato fora da etapa 15 (terminal, desconhecida ou ausente) não é associável", () => {
  for (const etapa of ["90", "80", "10", "??", null]) {
    const c = classificarAssociacao(entrada([item(1, 501, 2, "C1")], { C1: [po(9001, "1", [ip(77, 501, 2)], SAYERLACK, etapa)] }));
    assertEquals([c.classe, c.motivos], ["ambigua", ["po_fora_da_etapa_aberta"]], `etapa=${etapa}`);
  }
});

Deno.test("POs não consultados: nunca associável; estado decidido pela NF não ganha motivo de PO", () => {
  const nc = classificarAssociacao(entrada([item(1, 501, 2, "C1")], null));
  assertEquals([nc.classe, nc.motivos, nc.pares], ["ambigua", ["pedidos_nao_consultados"], []]);
  const conc = classificarAssociacao(entrada([item(1, 501, 2, "C1")], null, { cabec: { cEtapa: "80" }, info: { ...infoPendente, cRecebido: "S" } }));
  assertEquals([conc.classe, conc.motivos], ["fora_de_alcance", ["nf_concluida"]]);
});

Deno.test("payload real (item de NF pendente, recorte do detalhe de 14/10): 6 casas e L×UN → ambígua, nunca associável", () => {
  const real = {
    itensCabec: { cUnidadeNfe: "L", nIdItem: 0, nQtdeNFe: 1, nIdProduto: 8689717792, nSequencia: 1, cIgnorarItem: "N", cAssociarExistente: "S" },
    itensAjustes: { cUnidade: "UN", nQtdeRecebida: 0.055556, cNaoGerarMovEstoque: "N" },
    itensInfoAdic: { cCategoriaItem: "2.01.01", nNumPedCompra: "C1" },
  };
  const c = classificarAssociacao(entrada([real], { C1: [po(9001, "1", [ip(77, 8689717792, 1, { cUnidade: "UN" })])] }));
  assertEquals([c.estado_nf, c.classe, c.motivos], ["pendente", "ambigua", ["quantidade_ilegivel"]]);
});

Deno.test("vínculo existente no Omie: 1 de 2 itens vinculado é parcial, não 'resolvido'", () => {
  const c = classificarAssociacao(entrada(
    [item(1, 501, 2, "C1", { cab: { nIdItPedido: 77 } }), item(2, 502, 5, "C1")],
    { C1: [po(9001, "1", [ip(77, 501, 2), ip(78, 502, 5)])] },
  ));
  assertEquals([c.vinculo, c.classe, c.pares], ["parcial", "ja_vinculada", []]);
});

Deno.test("WP e equivalência: SKU com equivalência é ambíguo; equivalência não lida derruba tudo", () => {
  const pedidos = { C1: [po(9001, "1", [ip(77, 501, 2)])] };
  const wp = classificarAssociacao(entrada([item(1, 501, 2, "C1")], pedidos, { skusComEquivalencia: new Set(["501"]) }));
  assertEquals([wp.classe, wp.motivos], ["ambigua", ["sku_com_equivalencia_de_embalagem"]]);
  const nl = classificarAssociacao(entrada([item(1, 501, 2, "C1")], pedidos, { skusComEquivalencia: null }));
  assertEquals([nl.classe, nl.motivos], ["ambigua", ["equivalencia_nao_lida"]]);
});

Deno.test("ausência não vira dado: sem itens, todos ignorados, qtd/unidade/PO ilegíveis, unidade divergente", () => {
  const p = { C1: [po(9001, "1", [ip(77, 501, 2)])] };
  assertEquals(classificarAssociacao(entrada([], p)).motivos, ["nf_sem_itens"], "lista vazia");
  assertEquals(classificarAssociacao(entrada([item(1, 501, 2, "C1", { cab: { cIgnorarItem: "S" } })], p)).motivos, ["nf_sem_itens_ativos"], "todos ignorados");
  assertEquals(classificarAssociacao(entrada([item(1, 501, undefined, "C1")], p)).motivos, ["quantidade_ilegivel"], "qtd ausente");
  assertEquals(classificarAssociacao(entrada([item(1, 501, "1e3", "C1")], p)).motivos, ["quantidade_ilegivel"], "qtd exótica");
  assertEquals(classificarAssociacao(entrada([item(1, 501, 2, "C1", { aj: { cUnidade: "" } })], p)).motivos, ["unidade_ilegivel"], "unidade vazia");
  assertEquals(classificarAssociacao(entrada([item(1, 501, 2, "C1", { aj: { cUnidade: "L" } })], p)).motivos, ["unidade_divergente"], "L × GL");
  assertEquals(classificarAssociacao(entrada([item(1, 501, 2, "C1")], { C1: [po(9001, "1", [ip(77, 501, 2, { nQtdeRec: null })])] })).motivos, ["po_ilegivel"], "nQtdeRec null");
  assertEquals(classificarAssociacao(entrada([item(1, 501, 2, "C1")], { C1: [po(9001, "1", undefined)] })).motivos, ["po_sem_itens"], "PO sem documento");
  assertEquals(classificarAssociacao(entrada([item(1, 501, 2, "C1")], p, { fornecedor_codigo_omie: null })).motivos, ["fornecedor_ilegivel"], "fornecedor ausente");
});

Deno.test("PO com item ilegível fora da NF impede afirmar total/parcial", () => {
  const c = classificarAssociacao(entrada([item(1, 501, 2, "C1")], { C1: [po(9001, "1", [ip(77, 501, 2), ip(78, 502, "x")])] }));
  assertEquals([c.classe, c.motivos], ["ambigua", ["po_ilegivel"]]);
});

Deno.test("flags de item: não movimenta estoque, devolvido e sequência duplicada", () => {
  const p = { C1: [po(9001, "1", [ip(77, 501, 2), ip(78, 502, 1)])] };
  assertEquals(classificarAssociacao(entrada([item(1, 501, 2, "C1", { aj: { cNaoGerarMovEstoque: "S" } })], p)).motivos, ["item_nao_movimenta_estoque"]);
  assertEquals(classificarAssociacao(entrada([item(1, 501, 2, "C1", { cab: { cItemDevolvido: "S" } })], p)).motivos, ["item_devolvido"]);
  assertEquals(classificarAssociacao(entrada([item(1, 501, 2, "C1"), item(1, 502, 1, "C1")], p)).motivos, ["sequencia_duplicada"]);
});
