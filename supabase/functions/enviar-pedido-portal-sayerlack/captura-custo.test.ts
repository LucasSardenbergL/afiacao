// Testa a captura de custo PURA do portal Sayerlack (consolidar JSON do "Efetivar" + DOM + digitado, casar, derivar, sensor).
// Rodar: deno test supabase/functions/enviar-pedido-portal-sayerlack/
//
// Fatos de prod que estes testes preservam (2026-09-05, pedido #2443 / portal 2126906):
//   POST /order-creation/form/add → {"data":{"itens":[{"item":"WP06.3900QT","value":153.203},...],"value":"1605.67"}}
//   `value` do item = Preço UN de TABELA por embalagem (ANTES do desconto por embalagem e da taxa −2%);
//   `data.value` = total LÍQUIDO do pedido. Prova: 153.203 × (1−0.138678) × 0.98 = 129.318 (líquido de jul/2026).
//   ⇒ o `value` do item NUNCA vira custo direto; só o total do pedido (1 item) ou o DOM com checksum.
import {
  casarLinhasComItens,
  consolidarLinhasPortal,
  derivarCustos,
  extrairAddJson,
  parseBRL,
  parseDiasPrzEnt,
  classificarErroRpcCusto, resumirCaptura,
  toleranciaChecksum,
  type AddJsonPortal,
  type ItemEsperado,
  type ItemPedido,
  type LinhaDom,
} from "./captura-custo.ts";

// Asserts LOCAIS de propósito (sem jsr:@std/assert): `deno test --no-remote` roda no `validate` do CI.
function assertEquals(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: esperado ${String(expected)}, veio ${String(actual)}`);
}
function assertPerto(actual: number | null | undefined, expected: number, msg: string, eps = 1e-6) {
  if (typeof actual !== "number" || Math.abs(actual - expected) > eps) {
    throw new Error(`${msg}: esperado ≈${expected}, veio ${String(actual)}`);
  }
}

const dom = (o: Partial<LinhaDom> = {}): LinhaDom => ({
  sku_portal: "WP06.3900QT", prz_ent_raw: "5", qtd_un_raw: "2", preco_venda_raw: "129,3180", preco_un_raw: "153,2030", ...o,
});
const item = (o: Partial<ItemPedido> = {}): ItemPedido => ({
  item_id: 1, sku_codigo_omie: "8689733285", sku_descricao: "d", sku_portal: "WP06.3900QT", qtde_final: 2, preco_atual: 172.200046, ...o,
});
// Réplica do JSON real do pedido #2443 (3 itens; TEH é balde: 40 L Omie = 8 BB no portal).
const JSON_2443: AddJsonPortal = {
  itens: [
    { item: "WP06.3900QT", value: 153.203 },
    { item: "WP53.3900QT", value: 264.021 },
    { item: "TEH.3505.00BB", value: 124.9005 },
  ],
  value: 1605.67,
  ordernum: 2126906,
};
const ESPERADOS_2443: ItemEsperado[] = [
  { sku_portal: "WP06.3900QT", qtde_portal: 2 },
  { sku_portal: "WP53.3900QT", qtde_portal: 2 },
  { sku_portal: "TEH.3505.00BB", qtde_portal: 8 },
];
const DOM_2443: LinhaDom[] = [
  dom({ sku_portal: "WP06.3900QT", qtd_un_raw: "2", preco_venda_raw: "129,3180", preco_un_raw: "153,2030" }),
  dom({ sku_portal: "WP53.3900QT", qtd_un_raw: "2", preco_venda_raw: "222,8589", preco_un_raw: "264,0210" }),
  dom({ sku_portal: "TEH.3505.00BB", qtd_un_raw: "8", preco_venda_raw: "112,6650", preco_un_raw: "124,9005" }), // 2×129,318 + 2×222,8589 + 8×112,665 = 1605,67
];
const UNICO_JSON: AddJsonPortal = { itens: [{ item: "DFA.4080LT", value: 357.5466 }], value: 3238.63, ordernum: 1 };
const UNICO_ESP: ItemEsperado[] = [{ sku_portal: "DFA.4080LT", qtde_portal: 10 }];
const UNICO_DOM_CEGO = [dom({ sku_portal: "", qtd_un_raw: "10", preco_venda_raw: "", preco_un_raw: "357,5466" })];

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

// ---------------------------------------------------------------- consolidarLinhasPortal — 1 item
Deno.test("consolidar 1 item: total_linha = total líquido do pedido (json_total_unico); sku do JSON; prz e qtd da única linha do DOM", () => {
  const c = consolidarLinhasPortal(UNICO_DOM_CEGO, UNICO_JSON, UNICO_ESP);
  assertEquals(c.fonte, "json_total_unico", "fonte");
  assertEquals(c.linhas.length, 1, "1 linha");
  assertEquals(c.linhas[0].sku_portal, "DFA.4080LT", "sku do JSON (o DOM não identificou)");
  assertPerto(c.linhas[0].total_linha, 3238.63, "total = data.value, NÃO qtde×value (3575,47)");
  assertEquals(c.linhas[0].prz_ent_raw, "5", "prz herdado da única linha do DOM");
  assertPerto(c.total_pedido, 3238.63, "total do pedido provado");
});

Deno.test("consolidar 1 item: Qtd UN do DOM ≠ quantidade digitada ⇒ qtd_diverge (o total não é rateável sem prova de quantidade)", () => {
  const c = consolidarLinhasPortal([dom({ ...UNICO_DOM_CEGO[0], qtd_un_raw: "9" })], UNICO_JSON, UNICO_ESP);
  assertEquals(c.motivo, "qtd_diverge", "marca do ramo");
  assertEquals(c.linhas[0].total_linha, null, "sem custo");
});

Deno.test("consolidar 1 item: DOM com 2 linhas gravadas ⇒ dom_incompleto (o total cobriria 2 linhas)", () => {
  const c = consolidarLinhasPortal([DOM_2443[0], DOM_2443[1]], { itens: [{ item: "WP06.3900QT", value: 153.203 }], value: 258.636, ordernum: 1 }, [{ sku_portal: "WP06.3900QT", qtde_portal: 2 }]);
  assertEquals(c.fonte, "nenhuma", "fonte");
  assertEquals(c.motivo, "dom_incompleto", "marca do ramo");
});

Deno.test("consolidar 1 item: JSON traz sku diferente do digitado ⇒ json_diverge_do_pedido", () => {
  const c = consolidarLinhasPortal(UNICO_DOM_CEGO, UNICO_JSON, [{ sku_portal: "OUTRO.SKU", qtde_portal: 10 }]);
  assertEquals(c.motivo, "json_diverge_do_pedido", "marca do ramo");
});

// ---------------------------------------------------------------- consolidarLinhasPortal — N itens
Deno.test("consolidar N itens: DOM completo, quantidades e Preço UN batendo, checksum fechando ⇒ dom_checksum", () => {
  const c = consolidarLinhasPortal(DOM_2443, JSON_2443, ESPERADOS_2443);
  assertEquals(c.fonte, "dom_checksum", "fonte");
  assertEquals(c.linhas.length, 3, "3 linhas");
  assertPerto(c.linhas[0].total_linha, 258.636, "WP06 2×129,318");
  assertPerto(c.linhas[2].total_linha, 901.32, "TEH 8×112,665");
  assertEquals((c.checksum.delta_abs ?? 1) <= (c.checksum.tolerancia_abs ?? 0), true, "checksum fecha dentro da tolerância (portal arredonda o total a centavos: 1605,6738 → 1605,67)");
  assertPerto(c.total_pedido, 1605.67, "total provado");
});

Deno.test("consolidar N itens (adversário Codex): ler 'Preço UN' no lugar de 'Preço Venda' ⇒ checksum_divergente", () => {
  const domTabela = DOM_2443.map((l) => dom({ ...l, preco_venda_raw: l.preco_un_raw })); // 1833,65 ≠ 1605,67
  const c = consolidarLinhasPortal(domTabela, JSON_2443, ESPERADOS_2443);
  assertEquals(c.fonte, "nenhuma", "fonte");
  assertEquals(c.motivo, "checksum_divergente", "marca do ramo");
  assertEquals(c.linhas.every((l) => l.total_linha === null), true, "nenhum total fabricado");
  assertEquals((c.checksum.delta_abs ?? 0) > (c.checksum.tolerancia_abs ?? 0), true, "delta acima da tolerância");
});

Deno.test("consolidar N itens (adversário Codex): 'Qtd Fat' (litros) lida como 'Qtd UN' ⇒ qtd_diverge antes de qualquer soma", () => {
  const domLitros = DOM_2443.map((l, i) => (i === 2 ? dom({ ...l, qtd_un_raw: "40" }) : l)); // TEH: 40 L, não 8 BB
  assertEquals(consolidarLinhasPortal(domLitros, JSON_2443, ESPERADOS_2443).motivo, "qtd_diverge", "marca do ramo");
});

Deno.test("consolidar N itens: coluna 'Preço UN' do DOM ≠ value do JSON ⇒ preco_un_diverge (coluna não é a que se pensa)", () => {
  const domTrocado = DOM_2443.map((l) => dom({ ...l, preco_un_raw: l.preco_venda_raw }));
  assertEquals(consolidarLinhasPortal(domTrocado, JSON_2443, ESPERADOS_2443).motivo, "preco_un_diverge", "marca do ramo");
});

Deno.test("consolidar N itens: amostra NÃO discriminante (desconto 0) ainda produz o custo CERTO — Preço Venda == Preço UN, soma fecha", () => {
  const json: AddJsonPortal = { itens: [{ item: "A", value: 10 }, { item: "B", value: 20 }], value: 50, ordernum: 1 };
  const d = [dom({ sku_portal: "A", qtd_un_raw: "1", preco_venda_raw: "10,0000", preco_un_raw: "10,0000" }), dom({ sku_portal: "B", qtd_un_raw: "2", preco_venda_raw: "20,0000", preco_un_raw: "20,0000" })];
  const c = consolidarLinhasPortal(d, json, [{ sku_portal: "A", qtde_portal: 1 }, { sku_portal: "B", qtde_portal: 2 }]);
  assertEquals(c.fonte, "dom_checksum", "fonte");
  assertPerto(c.linhas[1].total_linha, 40, "B = 2×20");
});

Deno.test("consolidar N itens: DOM sem sku identificado (o defeito de prod: sku_portal='' em todas) ⇒ dom_incompleto, sem custo", () => {
  const domCego = DOM_2443.map((l) => dom({ ...l, sku_portal: "" }));
  const c = consolidarLinhasPortal(domCego, JSON_2443, ESPERADOS_2443);
  assertEquals(c.fonte, "nenhuma", "fonte");
  assertEquals(c.motivo, "dom_incompleto", "marca do ramo");
  assertEquals(c.linhas.map((l) => l.sku_portal).join(","), "WP06.3900QT,WP53.3900QT,TEH.3505.00BB", "sku vem do JSON mesmo assim");
});

Deno.test("consolidar N itens: qtd/preço vazios (colunas não achadas) ⇒ dom_incompleto", () => {
  assertEquals(consolidarLinhasPortal(DOM_2443.map((l) => dom({ ...l, preco_venda_raw: "" })), JSON_2443, ESPERADOS_2443).motivo, "dom_incompleto", "preco venda vazio");
  assertEquals(consolidarLinhasPortal(DOM_2443.map((l) => dom({ ...l, preco_un_raw: "" })), JSON_2443, ESPERADOS_2443).motivo, "dom_incompleto", "preco un vazio");
  assertEquals(consolidarLinhasPortal(DOM_2443.map((l) => dom({ ...l, qtd_un_raw: "0" })), JSON_2443, ESPERADOS_2443).motivo, "dom_incompleto", "qtd zero");
});

Deno.test("consolidar N itens: mesmo sku 2× no DOM ⇒ dom_incompleto/sku_ambiguo (nunca escolhe uma)", () => {
  const c = consolidarLinhasPortal([...DOM_2443, DOM_2443[0]], JSON_2443, ESPERADOS_2443);
  assertEquals(c.fonte, "nenhuma", "fonte");
  assertEquals(c.linhas.every((l) => l.total_linha === null), true, "sem custo");
  const c2 = consolidarLinhasPortal([DOM_2443[0], DOM_2443[0], DOM_2443[2]], JSON_2443, ESPERADOS_2443);
  assertEquals(c2.motivo, "sku_ambiguo", "mesmo tamanho, sku duplicado");
});

Deno.test("consolidar: JSON com sku duplicado ⇒ sku_ambiguo; JSON com item a mais/menos que o pedido ⇒ json_diverge_do_pedido", () => {
  const dup: AddJsonPortal = { itens: [JSON_2443.itens[0], JSON_2443.itens[0], JSON_2443.itens[2]], value: 1, ordernum: 1 };
  assertEquals(consolidarLinhasPortal(DOM_2443, dup, ESPERADOS_2443).motivo, "sku_ambiguo", "dup");
  assertEquals(consolidarLinhasPortal(DOM_2443, JSON_2443, ESPERADOS_2443.slice(0, 2)).motivo, "json_diverge_do_pedido", "pedido menor");
  assertEquals(consolidarLinhasPortal(DOM_2443, { ...JSON_2443, itens: JSON_2443.itens.slice(0, 2) }, ESPERADOS_2443).motivo, "json_diverge_do_pedido", "json menor");
});

Deno.test("consolidar: sem JSON ⇒ sem_json; linhas do DOM seguem (sku/prz) mas total null — o DOM sozinho não prova custo", () => {
  const c = consolidarLinhasPortal(DOM_2443, null, ESPERADOS_2443);
  assertEquals(c.fonte, "nenhuma", "fonte");
  assertEquals(c.motivo, "sem_json", "marca do ramo");
  assertEquals(c.linhas.length, 3, "linhas do DOM");
  assertEquals(c.linhas.every((l) => l.total_linha === null), true, "sem custo");
});

Deno.test("consolidar: total do pedido inválido no JSON ⇒ total_json_invalido, mesmo com 1 item", () => {
  assertEquals(consolidarLinhasPortal(UNICO_DOM_CEGO, { ...UNICO_JSON, value: null }, UNICO_ESP).motivo, "total_json_invalido", "null");
  assertEquals(consolidarLinhasPortal(UNICO_DOM_CEGO, { ...UNICO_JSON, value: 0 }, UNICO_ESP).motivo, "total_json_invalido", "zero");
});

Deno.test("toleranciaChecksum: derivada do arredondamento exibido (centavo por linha + total + 4ª casa × qtd)", () => {
  assertPerto(toleranciaChecksum([2, 2, 8]), 0.005 * 4 + 12 * 0.00005, "3 linhas");
  const json: AddJsonPortal = { itens: [{ item: "A", value: 10 }, { item: "B", value: 20 }], value: 50.02, ordernum: 1 }; // 0,02 acima: dentro (tol 0,015+…)? não: 0,02 > 0,01515
  const d = [dom({ sku_portal: "A", qtd_un_raw: "1", preco_venda_raw: "10,0000", preco_un_raw: "10,0000" }), dom({ sku_portal: "B", qtd_un_raw: "2", preco_venda_raw: "20,0000", preco_un_raw: "20,0000" })];
  assertEquals(consolidarLinhasPortal(d, json, [{ sku_portal: "A", qtde_portal: 1 }, { sku_portal: "B", qtde_portal: 2 }]).motivo, "checksum_divergente", "2 centavos fora em 3 arredondamentos reprova");
  assertEquals(consolidarLinhasPortal(d, { ...json, value: 50.01 }, [{ sku_portal: "A", qtde_portal: 1 }, { sku_portal: "B", qtde_portal: 2 }]).fonte, "dom_checksum", "1 centavo passa");
});

// ---------------------------------------------------------------- casar + derivar (fim a fim)
Deno.test("fim a fim #2443: dom_checksum → casa 3 → atualiza os 3 (custo em unidade OMIE: TEH 901,32 / 40 L)", () => {
  const c = consolidarLinhasPortal(DOM_2443, JSON_2443, ESPERADOS_2443);
  const itens = [
    item({ item_id: 12836, sku_codigo_omie: "8689733285", sku_portal: "WP06.3900QT", qtde_final: 2, preco_atual: 172.200046 }),
    item({ item_id: 12837, sku_codigo_omie: "8689783102", sku_portal: "WP53.3900QT", qtde_final: 2, preco_atual: 288.090035 }),
    item({ item_id: 12838, sku_codigo_omie: "8689961993", sku_portal: "TEH.3505.00BB", qtde_final: 40, preco_atual: 22.048505 }),
  ];
  const m = casarLinhasComItens(c.linhas, itens);
  assertEquals(m.casados.length, 3, "3 casados");
  const { updates, pulados } = derivarCustos(m);
  assertEquals(updates.length, 3, "3 updates");
  assertEquals(pulados.length, 0, "0 pulados");
  const teh = updates.find((u) => u.item_id === 12838);
  assertPerto(teh?.preco_unitario, 22.533, "TEH: 901,32 / 40 L (unidade Omie, não por balde)");
  assertPerto(teh?.valor_linha, 901.32, "valor_linha TEH");
});

Deno.test("fim a fim (defeito de prod): DOM cego + JSON multi-item → 0 updates e o motivo é total_invalido (nada fabricado)", () => {
  const c = consolidarLinhasPortal(DOM_2443.map((l) => dom({ ...l, sku_portal: "" })), JSON_2443, ESPERADOS_2443);
  const m = casarLinhasComItens(c.linhas, [item(), item({ item_id: 2, sku_codigo_omie: "X", sku_portal: "WP53.3900QT" }), item({ item_id: 3, sku_codigo_omie: "Y", sku_portal: "TEH.3505.00BB" })]);
  assertEquals(m.casados.length, 3, "casa pelo sku do JSON");
  const { updates, pulados } = derivarCustos(m);
  assertEquals(updates.length, 0, "0 updates");
  assertEquals(pulados.every((p) => p.motivo === "total_invalido"), true, "pulado por total_invalido");
});

Deno.test("casar: total_linha null é TERMINAL (não existe fallback textual que fabrique R$ a partir de 'Ação 2')", () => {
  const m = casarLinhasComItens([{ sku_portal: "WP06.3900QT", prz_ent_raw: "5", total_linha: null }], [item()]);
  assertEquals(m.casados[0].total_linha, null, "null");
  const m2 = casarLinhasComItens([{ sku_portal: "WP06.3900QT", prz_ent_raw: "5", total_linha: Number.POSITIVE_INFINITY }], [item()]);
  assertEquals(m2.casados[0].total_linha, null, "Infinity vira null");
});

Deno.test("derivarCustos: Infinity/NaN em total ou qtde nunca vira custo (Number.isFinite na última fronteira)", () => {
  const base = { naoCasados: [], ambiguos: [] };
  assertEquals(derivarCustos({ ...base, casados: [{ item: item({ qtde_final: Number.POSITIVE_INFINITY }), prz_ent: 5, total_linha: 100 }] }).pulados[0]?.motivo, "qtde_invalida", "qtde Infinity");
  assertEquals(derivarCustos({ ...base, casados: [{ item: item({ qtde_final: 1e-320 }), prz_ent: 5, total_linha: 1e300 }] }).pulados[0]?.motivo, "custo_invalido", "unitário Infinity");
});

Deno.test("parseBRL: pt-BR (ponto milhar, vírgula decimal); lixo → null", () => {
  assertPerto(parseBRL("R$ 1.633,45"), 1633.45, "brl");
  assertEquals(parseBRL(""), null, "vazio");
  assertEquals(parseBRL("abc"), null, "lixo");
});

// ---------------------------------------------------------------- sensor
const resumo = (o: Partial<Parameters<typeof resumirCaptura>[0]>) => resumirCaptura({
  cons: consolidarLinhasPortal(DOM_2443, JSON_2443, ESPERADOS_2443), match: null, pulados: [], planejados: 0, atualizados: 0,
  jaTemOmie: false, nDom: 3, nJson: 3, nItens: 3, ...o,
});

Deno.test("resumirCaptura: fonte nenhuma ⇒ CEGA (é o silêncio de prod virando sinal) com o motivo propagado", () => {
  const c = consolidarLinhasPortal(DOM_2443.map((l) => dom({ ...l, sku_portal: "" })), JSON_2443, ESPERADOS_2443);
  const m = casarLinhasComItens(c.linhas, [item()]);
  const r = resumo({ cons: c, match: m, pulados: derivarCustos(m).pulados, nItens: 1 });
  assertEquals(r.cego, true, "cego");
  assertEquals(r.motivo, "dom_incompleto", "motivo propagado");
});

Deno.test("resumirCaptura: todos sem_mudanca, todos casados, nada planejado ⇒ NÃO é cega (custo já batia)", () => {
  const c = consolidarLinhasPortal(UNICO_DOM_CEGO, { ...UNICO_JSON, value: 344.400092 }, UNICO_ESP);
  const m = casarLinhasComItens(c.linhas, [item({ sku_portal: "DFA.4080LT", qtde_final: 2, preco_atual: 172.200046 })]);
  const d = derivarCustos(m);
  assertEquals(d.pulados[0]?.motivo, "sem_mudanca", "pré-condição: sem_mudanca");
  assertEquals(resumo({ cons: c, match: m, pulados: d.pulados, nItens: 1, nDom: 1, nJson: 1 }).cego, false, "não cega");
});

Deno.test("resumirCaptura: item do pedido não casado, mesmo com os outros atualizados ⇒ cega (parcial conta)", () => {
  const c = consolidarLinhasPortal(DOM_2443, JSON_2443, ESPERADOS_2443);
  const m = casarLinhasComItens(c.linhas, [item(), item({ item_id: 9, sku_codigo_omie: "SEM_MAPA", sku_portal: null })]);
  const r = resumo({ cons: c, match: m, pulados: [], planejados: 1, atualizados: 1, nItens: 2 });
  assertEquals(r.nao_casados, 1, "1 não casado");
  assertEquals(r.cego, true, "cega parcial");
});

Deno.test("resumirCaptura: escrita parcial (planejados 3, atualizados 2) ⇒ cega com motivo escrita_parcial", () => {
  const c = consolidarLinhasPortal(DOM_2443, JSON_2443, ESPERADOS_2443);
  const m = casarLinhasComItens(c.linhas, [item(), item({ item_id: 2, sku_codigo_omie: "X", sku_portal: "WP53.3900QT" }), item({ item_id: 3, sku_codigo_omie: "Y", sku_portal: "TEH.3505.00BB" })]);
  const r = resumo({ cons: c, match: m, pulados: [{ sku_codigo_omie: "Y", motivo: "erro_update" }], planejados: 3, atualizados: 2 });
  assertEquals(r.cego, true, "cega");
  assertEquals(r.motivo, "escrita_parcial", "motivo");
});

Deno.test("classificarErroRpcCusto: casa a MARCA (SQLSTATE CP001..CP004); desconhecido/ausente ⇒ erro_rpc, nunca motivo fabricado", () => {
  assertEquals(classificarErroRpcCusto("CP001"), "payload_invalido", "CP001");
  assertEquals(classificarErroRpcCusto("CP002"), "po_omie_existente", "CP002");
  assertEquals(classificarErroRpcCusto("CP003"), "pedido_nao_elegivel", "CP003");
  assertEquals(classificarErroRpcCusto("CP004"), "itens_divergentes", "CP004");
  assertEquals(classificarErroRpcCusto("42501"), "erro_rpc", "permission denied não é motivo de negócio");
  assertEquals(classificarErroRpcCusto("CP005"), "erro_rpc", "código futuro não vira motivo conhecido");
  assertEquals(classificarErroRpcCusto("cp002"), "erro_rpc", "caixa fixa — não é ILIKE");
  assertEquals(classificarErroRpcCusto(undefined), "erro_rpc", "undefined");
  assertEquals(classificarErroRpcCusto(null), "erro_rpc", "null");
  assertEquals(classificarErroRpcCusto(""), "erro_rpc", "vazio");
});

const matchTres = () => {
  const c = consolidarLinhasPortal(DOM_2443, JSON_2443, ESPERADOS_2443);
  const m = casarLinhasComItens(c.linhas, [item(), item({ item_id: 2, sku_codigo_omie: "X", sku_portal: "WP53.3900QT" }), item({ item_id: 3, sku_codigo_omie: "Y", sku_portal: "TEH.3505.00BB" })]);
  return { c, m };
};

Deno.test("resumirCaptura: RPC recusou por itens divergentes (CP004) ⇒ NADA gravado (atualizados 0), cega, motivo itens_divergentes, sqlstate no resumo", () => {
  const { c, m } = matchTres();
  const r = resumo({ cons: c, match: m, planejados: 3, atualizados: 0, erroRpc: { motivo: "itens_divergentes", sqlstate: "CP004" } });
  assertEquals(r.cego, true, "cega");
  assertEquals(r.motivo, "itens_divergentes", "motivo é a MARCA do ramo, não escrita_parcial");
  assertEquals(r.sqlstate_rpc, "CP004", "sqlstate");
  assertEquals(r.atualizados, 0, "tudo-ou-nada: 0, nunca 2 de 3");
});

Deno.test("resumirCaptura: RPC recusou por PO Omie já existente no BANCO (CP002) ⇒ idempotência provada, NÃO é cega, motivo ja_tem_omie", () => {
  const { c, m } = matchTres();
  const r = resumo({ cons: c, match: m, planejados: 3, atualizados: 0, jaTemOmie: false, erroRpc: { motivo: "po_omie_existente", sqlstate: "CP002" } });
  assertEquals(r.cego, false, "não cega: o custo não pode mais mudar");
  assertEquals(r.motivo, "ja_tem_omie", "motivo");
  assertEquals(r.sqlstate_rpc, "CP002", "sqlstate");
});

Deno.test("resumirCaptura: erro transiente da RPC (erro_rpc, sem SQLSTATE) ⇒ cega com motivo erro_rpc (ausência de dado ≠ sucesso)", () => {
  const { c, m } = matchTres();
  const r = resumo({ cons: c, match: m, planejados: 3, atualizados: 0, erroRpc: { motivo: "erro_rpc", sqlstate: null } });
  assertEquals(r.cego, true, "cega");
  assertEquals(r.motivo, "erro_rpc", "motivo");
  assertEquals(r.sqlstate_rpc, null, "sqlstate");
});

Deno.test("resumirCaptura: RPC gravou tudo (planejados 3, atualizados 3, sem erro) ⇒ não cega, motivo null, sqlstate null", () => {
  const { c, m } = matchTres();
  const r = resumo({ cons: c, match: m, planejados: 3, atualizados: 3 });
  assertEquals(r.cego, false, "não cega");
  assertEquals(r.motivo, null, "motivo");
  assertEquals(r.sqlstate_rpc, null, "sqlstate");
});

Deno.test("resumirCaptura: já tem PO Omie ⇒ captura não roda, não é cega (idempotência, não silêncio)", () => {
  const r = resumo({ jaTemOmie: true });
  assertEquals(r.cego, false, "não cega");
  assertEquals(r.motivo, "ja_tem_omie", "motivo");
});

Deno.test("parseDiasPrzEnt: inteiro de dias do Prz Ent; vazio/lixo → null (alimenta o gate de grupo)", () => {
  assertEquals(parseDiasPrzEnt("5"), 5, "5");
  assertEquals(parseDiasPrzEnt(" 12 dias "), 12, "com texto");
  assertEquals(parseDiasPrzEnt(""), null, "vazio");
  assertEquals(parseDiasPrzEnt("n/a"), null, "lixo");
});
