// Testa a captura de custo PURA do portal Sayerlack: JSON do "Efetivar" + DOM + o que a edge digitou + a alíquota de
// IPI do NCM de cada item ⇒ linhas com mercadoria (sem IPI) e IPI PROVADOS, ou nada.
// Rodar: deno test supabase/functions/enviar-pedido-portal-sayerlack/
//
// Fatos de prod que estes testes preservam:
//   (2026-09-05, #2443) `value` do item no JSON = Preço UN de TABELA por embalagem — nunca é custo; `data.value` = cobrado.
//   (2026-09-05, #2459) `Preço Venda` do DOM = TOTAL DA LINHA: 142,2554 × 3 × (1 − 14,9488%) = 362,9698.
//   (2026-10-05, backtest de 29 pedidos) data.value = Σ round2(Preço Venda) + Σ IPI por item (alíquota do NCM): a
//     "divergência aberta" do #2459 era o IPI — 362,97 × 3,25% = 11,80 → 374,77. Os casos abaixo são PEDIDOS REAIS.
import {
  casarLinhasComItens, centavosDaMercadoria, centesimosDaAliquota, classificarErroRpcCusto, consolidarLinhasPortal,
  derivarCustos, extrairAddJson, ipiCentavos, parseBRL, parseDiasPrzEnt, resumirCaptura, round2, toleranciaChecksum,
  type AddJsonPortal, type ItemEsperado, type ItemPedido, type LinhaDom, type MotivoRpcCusto,
} from "./captura-custo.ts";

// Asserts LOCAIS de propósito (sem jsr:@std/assert): `deno test --no-remote` roda no `validate` do CI.
function assertEquals(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: esperado ${String(expected)}, veio ${String(actual)}`);
}
// `Number.isFinite`, nunca só `typeof === "number"`: com NaN, `Math.abs(NaN − x) > eps` é FALSO e o assert passaria —
// um total NaN (que vira null no JSON e a RPC recusa) ficaria verde em todos os testes (Codex 2026-10-06).
function assertPerto(actual: number | null | undefined, expected: number, msg: string, eps = 1e-6) {
  if (typeof actual !== "number" || !Number.isFinite(actual) || Math.abs(actual - expected) > eps) {
    throw new Error(`${msg}: esperado ≈${expected}, veio ${String(actual)}`);
  }
}

const dom = (o: Partial<LinhaDom> = {}): LinhaDom => ({ sku_portal: "X", prz_ent_raw: "5", qtd_un_raw: "1", preco_venda_raw: "1,0000", preco_un_raw: "1,0000", ...o });
const item = (o: Partial<ItemPedido> = {}): ItemPedido => ({ item_id: 1, sku_codigo_omie: "1", sku_descricao: "d", sku_portal: "X", qtde_final: 1, ...o });

// #3091 (portal 2133415): IPI misto. A NF 000953881 cobrou o WJOI a 242,25 — o round2 do Preço Venda.
const DOM_3091: LinhaDom[] = [
  dom({ sku_portal: "WJOI.7585GL", qtd_un_raw: "1", preco_un_raw: "284,8248", preco_venda_raw: "242,2470" }),
  dom({ sku_portal: "FC.6902L5", qtd_un_raw: "2", preco_un_raw: "250,9460", preco_venda_raw: "426,8652" }),
];
const JSON_3091: AddJsonPortal = { itens: [{ item: "WJOI.7585GL", value: 284.8248 }, { item: "FC.6902L5", value: 250.946 }], value: 704.74, ordernum: 2133415 };
const ESP_3091: ItemEsperado[] = [
  { sku_portal: "WJOI.7585GL", qtde_portal: 1, ncm: "3208.20.20", aliquota_ipi_pct: 3.25 },
  { sku_portal: "FC.6902L5", qtde_portal: 2, ncm: "3208.90.39", aliquota_ipi_pct: 6.5 },
];
// #2745: as 4 alíquotas (1,3% · 3,25% · 0% · 6,5%); modelado 4413,02 × 4413,01 cobrados — 1 centavo, tolerância 0,0454.
const DOM_2745: LinhaDom[] = [
  dom({ sku_portal: "YL.1424.02GL", qtd_un_raw: "4", preco_un_raw: "110,3076", preco_venda_raw: "375,2718" }),
  dom({ sku_portal: "WJOB.7666GL", qtd_un_raw: "4", preco_un_raw: "310,7957", preco_venda_raw: "1057,3419" }),
  dom({ sku_portal: "DEZ.8014L5", qtd_un_raw: "2", preco_un_raw: "219,5545", preco_venda_raw: "298,7742" }),
  dom({ sku_portal: "FC.6975LT", qtd_un_raw: "5", preco_un_raw: "583,4430", preco_venda_raw: "2481,1264" }),
];
const JSON_2745: AddJsonPortal = {
  itens: [{ item: "YL.1424.02GL", value: 110.3076 }, { item: "WJOB.7666GL", value: 310.7957 }, { item: "DEZ.8014L5", value: 219.5545 }, { item: "FC.6975LT", value: 583.443 }],
  value: 4413.01, ordernum: 2745,
};
const ESP_2745: ItemEsperado[] = [
  { sku_portal: "YL.1424.02GL", qtde_portal: 4, ncm: "3214.10.20", aliquota_ipi_pct: 1.3 },
  { sku_portal: "WJOB.7666GL", qtde_portal: 4, ncm: "3208.20.19", aliquota_ipi_pct: 3.25 },
  { sku_portal: "DEZ.8014L5", qtde_portal: 2, ncm: "2915.39.99", aliquota_ipi_pct: 0 },
  { sku_portal: "FC.6975LT", qtde_portal: 5, ncm: "3208.90.39", aliquota_ipi_pct: 6.5 },
];
// #2459 (portal 2126911, 1 item; WFBT.6045GL = NCM 3208.10.20): o caso que abriu a "divergência".
const DOM_2459: LinhaDom[] = [dom({ sku_portal: "WFBT.6045GL", qtd_un_raw: "3", preco_un_raw: "142,2554", preco_venda_raw: "362,9698" })];
const JSON_2459: AddJsonPortal = { itens: [{ item: "WFBT.6045GL", value: 142.2554 }], value: 374.77, ordernum: 2126911 };
const ESP_2459: ItemEsperado[] = [{ sku_portal: "WFBT.6045GL", qtde_portal: 3, ncm: "3208.10.20", aliquota_ipi_pct: 3.25 }];

// ---------------------------------------------------------------- extrairAddJson
Deno.test("extrairAddJson: lê itens + total do JSON real do form/add (value vem como STRING)", () => {
  const parsed = JSON.parse('{"success":true,"data":{"itens":[{"item":"WP06.3900QT","value":153.203},{"item":"TEH.3505.00BB","value":124.9005}],"value":"1605.67","ordernum":2126906},"nr_pedido":2126906}');
  const j = extrairAddJson(parsed);
  assertEquals(j?.itens.length, 2, "2 itens");
  assertEquals(j?.itens[0].item, "WP06.3900QT", "sku exato");
  assertPerto(j?.itens[0].value, 153.203, "value numérico");
  assertPerto(j?.value, 1605.67, "total do pedido parseado da string");
  assertEquals(j?.ordernum, 2126906, "ordernum");
});
Deno.test("extrairAddJson: '153.203' em string NÃO vira 153203; '1.605,67' pt-BR parseia; lixo vira null (não zero)", () => {
  assertPerto(extrairAddJson({ data: { itens: [{ item: "A", value: "153.203" }], value: "1.605,67" } })?.itens[0].value, 153.203, "ponto decimal");
  assertPerto(extrairAddJson({ data: { itens: [{ item: "A", value: 1 }], value: "1.605,67" } })?.value, 1605.67, "pt-BR");
  assertEquals(extrairAddJson({ data: { itens: [{ item: "A", value: 1 }], value: "abc" } })?.value, null, "lixo → null");
});
Deno.test("extrairAddJson: sem data.itens (ou itens malformados) → null, nunca lista vazia disfarçada", () => {
  assertEquals(extrairAddJson(null), null, "null");
  assertEquals(extrairAddJson({ success: true, message: "Itens salvos na sessão" }), null, "save-tab-preco-session");
  assertEquals(extrairAddJson({ data: { itens: [] } }), null, "itens vazio");
  assertEquals(extrairAddJson({ data: { itens: [{ item: "", value: 1 }] } }), null, "item sem sku");
  assertEquals(extrairAddJson({ data: { itens: [{ item: "A", value: "x" }] } }), null, "value não numérico");
});

// ---------------------------------------------------------------- centavos (a conta que a RPC refaz em numeric)
Deno.test("centavos: o IPI em inteiros bate com o round(numeric, 2) do Postgres na fronteira de meio centavo", () => {
  assertEquals(ipiCentavos(6500, 650), 423, "R$ 65,00 × 6,5% = 4,225 → 4,23");
  assertEquals(round2(round2(65) * 6.5 / 100), 4.22, "o ponto flutuante erra o mesmo caso (é por isso que a conta é inteira)");
  assertEquals(ipiCentavos(42687, 650), 2775, "426,87 × 6,5% = 27,74655 → 27,75");
  assertEquals(ipiCentavos(24225, 325), 787, "242,25 × 3,25% = 7,873125 → 7,87");
  assertEquals(ipiCentavos(1371, 0), 0, "0% medido é 0");
});
Deno.test("centavosDaMercadoria: 4 casas do DOM viram centavos com meio-para-cima; ≤ 0, NaN e Infinity → null", () => {
  assertEquals(centavosDaMercadoria(426.8652), 42687, "426,8652 → 426,87");
  assertEquals(centavosDaMercadoria(100.005), 10001, "meio centavo sobe");
  assertEquals(centavosDaMercadoria(242.247), 24225, "242,247 → 242,25");
  assertEquals(centavosDaMercadoria(0), null, "zero");
  assertEquals(centavosDaMercadoria(-1), null, "negativo");
  assertEquals(centavosDaMercadoria(Number.NaN), null, "NaN");
  assertEquals(centavosDaMercadoria(Number.POSITIVE_INFINITY), null, "Infinity");
});
Deno.test("centesimosDaAliquota: 2 casas em [0, 100); fora disso ou null → null (nunca 0%)", () => {
  assertEquals(centesimosDaAliquota(3.25), 325, "3,25");
  assertEquals(centesimosDaAliquota(1.3), 130, "1,3");
  assertEquals(centesimosDaAliquota(0), 0, "0 medido");
  assertEquals(centesimosDaAliquota(3.255), null, "3 casas");
  assertEquals(centesimosDaAliquota(100), null, "100");
  assertEquals(centesimosDaAliquota(-0.01), null, "negativa");
  assertEquals(centesimosDaAliquota(null), null, "ausente");
});
Deno.test("toleranciaChecksum: meio centavo do total + 0,0101 por linha", () => {
  assertPerto(toleranciaChecksum(1), 0.0151, "1 linha");
  assertPerto(toleranciaChecksum(18), 0.1868, "18 linhas");
});

// ---------------------------------------------------------------- consolidarLinhasPortal — a prova com IPI
Deno.test("1 item (#2459): linha 362,97 + IPI 11,80 = 374,77 exato ⇒ dom_checksum; total_linha é a MERCADORIA (sem IPI)", () => {
  const c = consolidarLinhasPortal(DOM_2459, JSON_2459, ESP_2459, "ok");
  assertEquals(c.fonte, "dom_checksum", "fonte");
  assertPerto(c.linhas[0].total_linha, 362.9698, "mercadoria = Preço Venda, não data.value");
  assertEquals(c.linhas[0].valor_ipi, 11.8, "IPI do item");
  assertEquals(c.checksum.total_modelado, 374.77, "modelado");
  assertEquals(c.checksum.delta_abs, 0, "fecha no centavo");
  assertPerto(c.total_pedido, 374.77, "cobrado provado");
});
Deno.test("N itens (#3091): 426,87 × 6,5% = 27,75 e 242,25 × 3,25% = 7,87 ⇒ 704,74 exato", () => {
  const c = consolidarLinhasPortal(DOM_3091, JSON_3091, ESP_3091, "ok");
  assertEquals(c.fonte, "dom_checksum", "fonte");
  assertEquals(c.linhas.map((l) => l.valor_ipi).join(","), "7.87,27.75", "IPI por linha na ordem do JSON");
  assertEquals(c.checksum.ipi_modelado, 35.62, "IPI total");
  assertEquals(c.checksum.total_modelado, 704.74, "modelado");
});
Deno.test("#2745: 4 alíquotas, 1 centavo de arredondamento dentro da tolerância de 4 linhas", () => {
  const c = consolidarLinhasPortal(DOM_2745, JSON_2745, ESP_2745, "ok");
  assertEquals(c.fonte, "dom_checksum", "fonte");
  assertEquals(c.linhas.map((l) => l.valor_ipi).join(","), "4.88,34.36,0,161.27", "1,3% · 3,25% · 0% · 6,5%");
  assertEquals(c.checksum.total_modelado, 4413.02, "modelado");
  assertPerto(c.checksum.delta_abs, 0.01, "delta medido");
  assertPerto(c.checksum.tolerancia_abs, 0.0454, "tolerância de 4 linhas");
});
Deno.test("tolerância: 2 linhas aceitam 2 centavos e recusam 3", () => {
  assertEquals(consolidarLinhasPortal(DOM_3091, { ...JSON_3091, value: 704.76 }, ESP_3091, "ok").fonte, "dom_checksum", "0,02 ≤ 0,0252");
  assertEquals(consolidarLinhasPortal(DOM_3091, { ...JSON_3091, value: 704.77 }, ESP_3091, "ok").motivo, "checksum_divergente", "0,03 > 0,0252");
});
Deno.test("sem o IPI modelado (alíquota 0 informada no #2459) ⇒ checksum_divergente com os R$ 11,80 medidos", () => {
  const c = consolidarLinhasPortal(DOM_2459, JSON_2459, [{ ...ESP_2459[0], aliquota_ipi_pct: 0 }], "ok");
  assertEquals(c.motivo, "checksum_divergente", "a divergência de 2026-09-05, agora explicada");
  assertPerto(c.checksum.delta_abs, 11.8, "delta");
  assertEquals(c.linhas.every((l) => l.total_linha === null && l.valor_ipi === null), true, "nada provado");
});
Deno.test("alíquota errada (6,5% no lugar de 3,25%) ⇒ checksum_divergente: a prova falsifica a tabela", () => {
  const esp = ESP_3091.map((e) => (e.sku_portal === "WJOI.7585GL" ? { ...e, aliquota_ipi_pct: 6.5 } : e));
  assertEquals(consolidarLinhasPortal(DOM_3091, JSON_3091, esp, "ok").motivo, "checksum_divergente", "15,75 − 7,87 = R$ 7,88 de erro");
});
Deno.test("item sem alíquota ⇒ ipi_ncm_desconhecido com os NCMs na lista — nunca IPI 0", () => {
  const esp = ESP_3091.map((e) => (e.sku_portal === "FC.6902L5" ? { ...e, aliquota_ipi_pct: null } : e));
  const c = consolidarLinhasPortal(DOM_3091, JSON_3091, esp, "ok");
  assertEquals(c.motivo, "ipi_ncm_desconhecido", "marca do ramo");
  assertEquals(c.ncm_sem_aliquota.join(","), "3208.90.39", "o que cadastrar");
  const sem = consolidarLinhasPortal(DOM_2459, JSON_2459, [{ ...ESP_2459[0], ncm: null, aliquota_ipi_pct: null }], "ok");
  assertEquals(sem.ncm_sem_aliquota.join(","), "(sem NCM)", "produto sem NCM no cadastro");
});
Deno.test("leitura das alíquotas falhou ⇒ ipi_leitura_falhou (não consegui ler ≠ não existe)", () => {
  const c = consolidarLinhasPortal(DOM_3091, JSON_3091, ESP_3091, "falhou");
  assertEquals(c.motivo, "ipi_leitura_falhou", "marca do ramo");
  assertEquals(c.ncm_sem_aliquota.length, 0, "não acusa NCM que não foi lido");
});
Deno.test("1 item sem Preço Venda no DOM ⇒ dom_incompleto: data.value cego não prova mais a linha", () => {
  const c = consolidarLinhasPortal([dom({ ...DOM_2459[0], preco_venda_raw: "" })], JSON_2459, ESP_2459, "ok");
  assertEquals(c.motivo, "dom_incompleto", "marca do ramo");
});
Deno.test("1 item com o sku NÃO lido no DOM (defeito histórico): a linha única vale como a dele", () => {
  const c = consolidarLinhasPortal([dom({ ...DOM_2459[0], sku_portal: "" })], JSON_2459, ESP_2459, "ok");
  assertEquals(c.fonte, "dom_checksum", "fonte");
  assertEquals(c.linhas[0].sku_portal, "WFBT.6045GL", "sku vem do JSON");
});
Deno.test("adversário: ler 'Preço UN' no lugar de 'Preço Venda' ⇒ checksum_divergente", () => {
  const d = DOM_3091.map((l) => ({ ...l, preco_venda_raw: l.preco_un_raw }));
  assertEquals(consolidarLinhasPortal(d, JSON_3091, ESP_3091, "ok").motivo, "checksum_divergente", "marca do ramo");
});
Deno.test("adversário: 'Qtd Fat' lida como 'Qtd UN' ⇒ qtd_diverge antes de qualquer soma", () => {
  const d = DOM_3091.map((l, i) => (i === 1 ? { ...l, qtd_un_raw: "4" } : l));
  assertEquals(consolidarLinhasPortal(d, JSON_3091, ESP_3091, "ok").motivo, "qtd_diverge", "marca do ramo");
});
Deno.test("coluna 'Preço UN' do DOM ≠ value do JSON ⇒ preco_un_diverge", () => {
  const d = DOM_3091.map((l) => ({ ...l, preco_un_raw: l.preco_venda_raw }));
  assertEquals(consolidarLinhasPortal(d, JSON_3091, ESP_3091, "ok").motivo, "preco_un_diverge", "marca do ramo");
});
Deno.test("DOM sem sku identificado (N itens) ⇒ dom_incompleto, sem custo; sku vem do JSON", () => {
  const c = consolidarLinhasPortal(DOM_3091.map((l) => ({ ...l, sku_portal: "" })), JSON_3091, ESP_3091, "ok");
  assertEquals(c.motivo, "dom_incompleto", "marca do ramo");
  assertEquals(c.linhas.map((l) => l.sku_portal).join(","), "WJOI.7585GL,FC.6902L5", "sku do JSON");
});
Deno.test("qtd/preço vazios ⇒ dom_incompleto", () => {
  assertEquals(consolidarLinhasPortal(DOM_3091.map((l) => ({ ...l, preco_venda_raw: "" })), JSON_3091, ESP_3091, "ok").motivo, "dom_incompleto", "preço venda");
  assertEquals(consolidarLinhasPortal(DOM_3091.map((l) => ({ ...l, preco_un_raw: "" })), JSON_3091, ESP_3091, "ok").motivo, "dom_incompleto", "preço un");
  assertEquals(consolidarLinhasPortal(DOM_3091.map((l) => ({ ...l, qtd_un_raw: "0" })), JSON_3091, ESP_3091, "ok").motivo, "dom_incompleto", "qtd zero");
});
Deno.test("mesmo sku 2× no DOM ⇒ nunca escolhe uma", () => {
  assertEquals(consolidarLinhasPortal([...DOM_3091, DOM_3091[0]], JSON_3091, ESP_3091, "ok").fonte, "nenhuma", "DOM maior");
  assertEquals(consolidarLinhasPortal([DOM_3091[0], DOM_3091[0]], JSON_3091, ESP_3091, "ok").motivo, "sku_ambiguo", "mesmo tamanho");
});
Deno.test("JSON com sku duplicado ⇒ sku_ambiguo; item a mais/menos que o pedido ⇒ json_diverge_do_pedido", () => {
  const dup: AddJsonPortal = { itens: [JSON_3091.itens[0], JSON_3091.itens[0]], value: 1, ordernum: 1 };
  assertEquals(consolidarLinhasPortal(DOM_3091, dup, ESP_3091, "ok").motivo, "sku_ambiguo", "dup");
  assertEquals(consolidarLinhasPortal(DOM_3091, JSON_3091, ESP_3091.slice(0, 1), "ok").motivo, "json_diverge_do_pedido", "pedido menor");
  assertEquals(consolidarLinhasPortal(DOM_3091, { ...JSON_3091, itens: JSON_3091.itens.slice(0, 1) }, ESP_3091, "ok").motivo, "json_diverge_do_pedido", "json menor");
});
Deno.test("sem JSON ⇒ sem_json; as linhas do DOM seguem (sku/prz) com mercadoria e IPI null", () => {
  const c = consolidarLinhasPortal(DOM_3091, null, ESP_3091, "ok");
  assertEquals(c.motivo, "sem_json", "marca do ramo");
  assertEquals(c.linhas.every((l) => l.total_linha === null && l.valor_ipi === null), true, "sem custo");
});
Deno.test("total do pedido inválido no JSON ⇒ total_json_invalido", () => {
  assertEquals(consolidarLinhasPortal(DOM_2459, { ...JSON_2459, value: null }, ESP_2459, "ok").motivo, "total_json_invalido", "null");
  assertEquals(consolidarLinhasPortal(DOM_2459, { ...JSON_2459, value: 0 }, ESP_2459, "ok").motivo, "total_json_invalido", "zero");
});

// ---------------------------------------------------------------- casar + derivar
Deno.test("fim a fim #3091: consolida → casa → deriva o payload da RPC (mercadoria + IPI + eco da qtde)", () => {
  const c = consolidarLinhasPortal(DOM_3091, JSON_3091, ESP_3091, "ok");
  const m = casarLinhasComItens(c.linhas, [
    item({ item_id: 101, sku_codigo_omie: "8689962883", sku_portal: "FC.6902L5", qtde_final: 2 }),
    item({ item_id: 102, sku_codigo_omie: "8689743214", sku_portal: "WJOI.7585GL", qtde_final: 1 }),
  ]);
  const { updates, pulados } = derivarCustos(m);
  assertEquals(pulados.length, 0, "0 pulados");
  assertEquals(JSON.stringify(updates.sort((a, b) => a.item_id - b.item_id)),
    '[{"item_id":101,"qtde_final":2,"valor_mercadoria":426.8652,"valor_ipi":27.75},{"item_id":102,"qtde_final":1,"valor_mercadoria":242.247,"valor_ipi":7.87}]',
    "o payload EXATO que a RPC recebe");
});
Deno.test("casar: mercadoria e IPI null/Infinity são TERMINAIS", () => {
  const m = casarLinhasComItens([{ sku_portal: "X", prz_ent_raw: "5", total_linha: Number.POSITIVE_INFINITY, valor_ipi: Number.NaN }], [item()]);
  assertEquals(m.casados[0].total_linha, null, "Infinity vira null");
  assertEquals(m.casados[0].valor_ipi, null, "NaN vira null");
});
Deno.test("derivarCustos: IPI ausente/negativo, mercadoria ou qtde inválida ⇒ pulado, nunca update", () => {
  const caso = (total_linha: number | null, valor_ipi: number | null, qtde = 1) =>
    derivarCustos({ casados: [{ item: item({ qtde_final: qtde }), prz_ent: 5, total_linha, valor_ipi }], naoCasados: [], ambiguos: [] });
  assertEquals(caso(100, null).pulados[0]?.motivo, "ipi_invalido", "IPI ausente");
  assertEquals(caso(100, -0.01).pulados[0]?.motivo, "ipi_invalido", "IPI negativo");
  assertEquals(caso(null, 1).pulados[0]?.motivo, "total_invalido", "mercadoria ausente");
  assertEquals(caso(0, 1).pulados[0]?.motivo, "total_invalido", "mercadoria zero");
  assertEquals(caso(100, 1, 0).pulados[0]?.motivo, "qtde_invalida", "qtde zero");
  assertEquals(caso(100, 0).updates.length, 1, "IPI 0 medido é update");
});

// ---------------------------------------------------------------- sensor
const prov = () => {
  const c = consolidarLinhasPortal(DOM_3091, JSON_3091, ESP_3091, "ok");
  const m = casarLinhasComItens(c.linhas, [item({ item_id: 101, sku_portal: "FC.6902L5", qtde_final: 2 }), item({ item_id: 102, sku_portal: "WJOI.7585GL" })]);
  return { c, m };
};
const resumo = (o: Partial<Parameters<typeof resumirCaptura>[0]>) => {
  const { c, m } = prov();
  return resumirCaptura({ cons: c, match: m, pulados: [], planejados: 2, atualizados: 2, jaTemOmie: false, nDom: 2, nJson: 2, nItens: 2, ...o });
};
Deno.test("resumirCaptura: pedido inteiro gravado ⇒ não cega, motivo null", () => {
  const r = resumo({});
  assertEquals(r.cego, false, "não cega");
  assertEquals(r.motivo, null, "motivo");
  assertEquals(r.ncm_sem_aliquota.length, 0, "nada a cadastrar");
});
Deno.test("resumirCaptura: ipi_ncm_desconhecido ⇒ cega, com a lista de NCMs no resumo", () => {
  const c = consolidarLinhasPortal(DOM_3091, JSON_3091, ESP_3091.map((e) => ({ ...e, aliquota_ipi_pct: null })), "ok");
  const r = resumo({ cons: c, planejados: 0, atualizados: 0 });
  assertEquals(r.cego, true, "cega");
  assertEquals(r.motivo, "ipi_ncm_desconhecido", "motivo");
  assertEquals(r.ncm_sem_aliquota.join(","), "3208.20.20,3208.90.39", "lista ordenada");
});
Deno.test("resumirCaptura: qualquer item pulado ⇒ cega (o pulo 'sem_mudanca' não existe mais)", () => {
  assertEquals(resumo({ pulados: [{ sku_codigo_omie: "1", motivo: "ipi_invalido" }], planejados: 0, atualizados: 0 }).cego, true, "cega");
});
Deno.test("resumirCaptura: item não casado ⇒ cega (parcial conta)", () => {
  const { c } = prov();
  const m = casarLinhasComItens(c.linhas, [item({ sku_portal: "FC.6902L5" }), item({ item_id: 9, sku_portal: null })]);
  assertEquals(resumo({ match: m, planejados: 1, atualizados: 1 }).cego, true, "cega");
});
Deno.test("resumirCaptura: escrita parcial ⇒ cega escrita_parcial", () => {
  const r = resumo({ planejados: 2, atualizados: 1 });
  assertEquals(r.cego, true, "cega");
  assertEquals(r.motivo, "escrita_parcial", "motivo");
});
Deno.test("resumirCaptura: recusas da RPC viram a MARCA do ramo; CP002 é idempotência (não cega)", () => {
  const casos: [MotivoRpcCusto, string | null, boolean][] = [
    ["itens_divergentes", "CP004", true], ["aliquota_ipi_ausente", "CP006", true], ["prova_ipi_divergente", "CP007", true],
    ["erro_rpc", null, true], ["po_omie_existente", "CP002", false],
  ];
  for (const [motivo, sqlstate, cego] of casos) {
    const r = resumo({ atualizados: 0, erroRpc: { motivo, sqlstate } });
    assertEquals(r.cego, cego, `cego (${motivo})`);
    assertEquals(r.motivo, motivo === "po_omie_existente" ? "ja_tem_omie" : motivo, `motivo (${motivo})`);
  }
});
Deno.test("resumirCaptura: já tem PO Omie ⇒ a captura não grava e não é cega", () => {
  const r = resumo({ jaTemOmie: true, planejados: 0, atualizados: 0 });
  assertEquals(r.cego, false, "não cega");
  assertEquals(r.motivo, "ja_tem_omie", "motivo");
});
Deno.test("classificarErroRpcCusto: CP001–CP004, CP006, CP007; o resto (inclusive o CP005 aposentado) é erro_rpc", () => {
  const mapa: [string | null | undefined, string][] = [
    ["CP001", "payload_invalido"], ["CP002", "po_omie_existente"], ["CP003", "pedido_nao_elegivel"], ["CP004", "itens_divergentes"],
    ["CP006", "aliquota_ipi_ausente"], ["CP007", "prova_ipi_divergente"], ["CP005", "erro_rpc"], ["42501", "erro_rpc"],
    ["cp006", "erro_rpc"], ["", "erro_rpc"], [null, "erro_rpc"], [undefined, "erro_rpc"],
  ];
  for (const [code, motivo] of mapa) assertEquals(classificarErroRpcCusto(code), motivo, String(code));
});

// ---------------------------------------------------------------- parsers
Deno.test("parseBRL: pt-BR (ponto milhar, vírgula decimal); lixo → null", () => {
  assertPerto(parseBRL("R$ 1.633,45"), 1633.45, "brl");
  assertEquals(parseBRL(""), null, "vazio");
  assertEquals(parseBRL("abc"), null, "lixo");
});
Deno.test("parseDiasPrzEnt: inteiro de dias do Prz Ent; vazio/lixo → null (alimenta o gate de grupo)", () => {
  assertEquals(parseDiasPrzEnt("5"), 5, "5");
  assertEquals(parseDiasPrzEnt(" 12 dias "), 12, "com texto");
  assertEquals(parseDiasPrzEnt(""), null, "vazio");
  assertEquals(parseDiasPrzEnt("n/a"), null, "lixo");
});
