// Canon de omie-pedido.ts (#B). Roda: deno test supabase/functions/_shared/omie-pedido_test.ts
import {
  omieEtapaToStatus,
  etapaConhecida,
  statusEhOmie,
  subtotalPedidoComDesconto,
  construirItemsJson,
  diffOrderItens,
} from "./omie-pedido.ts";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

Deno.test("etapa→status casa o canon do omie-vendas-sync", () => {
  eq(omieEtapaToStatus("50"), "separacao", "50");
  eq(omieEtapaToStatus("60"), "faturado", "60");
  eq(omieEtapaToStatus("70"), "faturado", "70");
  eq(omieEtapaToStatus("80"), "cancelado", "80");
  eq(omieEtapaToStatus("20"), "enviado", "20");
  eq(omieEtapaToStatus("10"), "importado", "10→default");
  eq(omieEtapaToStatus(""), "importado", "vazio→default");
  eq(omieEtapaToStatus(undefined), "importado", "undefined→default");
});

Deno.test("REGRESSÃO #B: 60≠cancelado e 50≠faturado (mapa invertido do reprocess antigo)", () => {
  if (omieEtapaToStatus("60") === "cancelado") throw new Error("60 não pode ser cancelado");
  if (omieEtapaToStatus("50") === "faturado") throw new Error("50 não pode ser faturado");
});

Deno.test("etapaConhecida: só 20/50/60/70/80 (reprocess não rebaixa status em leitura malformada)", () => {
  for (const e of ["20", "50", "60", "70", "80"]) eq(etapaConhecida(e), true, `conhecida ${e}`);
  for (const e of ["10", "", undefined, "99", "x"]) eq(etapaConhecida(e), false, `desconhecida ${e}`);
});

Deno.test("statusEhOmie: gerido pelo Omie vs app-avançado (reprocess não clobbera confirmado/entregue)", () => {
  for (const s of ["importado", "separacao", "enviado", "faturado", "cancelado"]) eq(statusEhOmie(s), true, `omie ${s}`);
  for (const s of ["confirmado", "entregue", "rascunho", "pendente", "", undefined]) eq(statusEhOmie(s), false, `app ${s}`);
});

Deno.test("subtotal soma com desconto percentual, || (qty 0→1, igual ao sync) e arredonda", () => {
  eq(subtotalPedidoComDesconto([{ produto: { quantidade: 2, valor_unitario: 10 } }]), 20, "sem desconto");
  eq(subtotalPedidoComDesconto([{ produto: { quantidade: 1, valor_unitario: 100, desconto: 10 } }]), 90, "10%");
  eq(subtotalPedidoComDesconto([{ produto: { quantidade: 3, valor_unitario: 33.333 } }]), 100, "arredonda");
  eq(subtotalPedidoComDesconto([{ produto: { quantidade: 0, valor_unitario: 10 } }]), 10, "qty 0 → 1 (|| igual ao sync)");
  eq(subtotalPedidoComDesconto([{}]), 0, "det sem produto");
});

Deno.test("construirItemsJson casa o snapshot do sync (chaves + cor de tinta da obs)", () => {
  const det = [
    { produto: { codigo_produto: 8, descricao: "PINO F15", quantidade: 3, valor_unitario: 13.85, desconto: 0 } },
    { produto: { codigo_produto: 9, descricao: "BASE PU", quantidade: 1, valor_unitario: 86 }, observacao: { obs_item: "Cor: AZUL RAL 5010 - GL" } },
  ];
  const out = construirItemsJson(det);
  eq(out[0], { omie_codigo_produto: 8, descricao: "PINO F15", quantidade: 3, valor_unitario: 13.85, desconto: 0 }, "item comum");
  eq(out[1].tint_nome_cor, "AZUL RAL 5010", "cor de tinta extraída da obs");
  eq(out[1].descricao, "BASE PU", "descricao");
  // sem cor → sem chave tint
  eq("tint_nome_cor" in construirItemsJson([{ produto: { codigo_produto: 1, descricao: "X", quantidade: 1, valor_unitario: 1 } }])[0], false, "sem obs → sem tint");
});

Deno.test("diff: insere novo, atualiza divergente (e grava hash de identidade), deleta removido, no-op igual", () => {
  const locais = [
    { id: "A", omie_codigo_produto: 1, quantity: 2, unit_price: 10, discount: 0, product_id: "p1" }, // igual → no-op
    { id: "B", omie_codigo_produto: 2, quantity: 1, unit_price: 5, discount: 0, product_id: null }, // qty diverge → update
    { id: "C", omie_codigo_produto: 3, quantity: 1, unit_price: 9, discount: 0, product_id: "p3" }, // removido → delete
  ];
  const desejados = [
    { omie_codigo_produto: 1, quantity: 2, unit_price: 10, discount: 0, product_id: "p1", hash_payload: "omie_oben_77_1" },
    { omie_codigo_produto: 2, quantity: 4, unit_price: 5, discount: 0, product_id: null, hash_payload: "omie_oben_77_2" },
    { omie_codigo_produto: 9, quantity: 1, unit_price: 7, discount: 0, product_id: "p9", hash_payload: "omie_oben_77_9" }, // novo → insert
  ];
  const d = diffOrderItens(locais, desejados);
  eq(d.inserir.map((i) => i.omie_codigo_produto), [9], "inserir");
  eq(d.atualizar.map((u) => u.id), ["B"], "atualizar ids");
  eq(d.atualizar[0].quantity, 4, "atualizar qty nova");
  eq(d.atualizar[0].hash_payload, "omie_oben_77_2", "update grava hash de IDENTIDADE (repara legado)");
  eq(d.deletar, ["C"], "deletar");
});

Deno.test("diff: tolerância numérica (float repr) não vira atualização espúria", () => {
  const locais = [{ id: "A", omie_codigo_produto: 1, quantity: 1, unit_price: 152.85, discount: 0, product_id: "p1" }];
  const desejados = [
    { omie_codigo_produto: 1, quantity: 1, unit_price: 152.85000000000002, discount: 0, product_id: "p1", hash_payload: "h_1" },
  ];
  eq(diffOrderItens(locais, desejados).atualizar, [], "diferença de 2e-14 não é divergência");
});
