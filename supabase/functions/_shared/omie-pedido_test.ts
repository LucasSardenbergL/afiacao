// Canon de omie-pedido.ts (#B). Roda: deno test supabase/functions/_shared/omie-pedido_test.ts
import {
  omieEtapaToStatus,
  etapaConhecida,
  subtotalPedidoComDesconto,
  construirItemsJson,
  STATUS_GERIDO_OMIE,
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

Deno.test("STATUS_GERIDO_OMIE: exatamente os status cujo dono é o Omie", () => {
  eq([...STATUS_GERIDO_OMIE].sort(), ["cancelado", "enviado", "faturado", "importado", "separacao"], "conjunto canônico");
  // O que este assert protege: a lista viaja como argumento para `reconciliar_pedidos_omie`, que
  // a compara por CONJUNTO com a sua cópia e LANÇA se divergir. Um status app-avançado entrando
  // aqui faria a reconciliação rebaixar pedido que o time já avançou à mão.
  for (const s of ["confirmado", "entregue", "rascunho", "pendente"]) {
    eq(STATUS_GERIDO_OMIE.includes(s), false, `app-avançado ${s} NÃO é gerido pelo Omie`);
  }
});

Deno.test("todo status que omieEtapaToStatus produz está na lista enviada à RPC", () => {
  // Se um mapa de etapa novo emitisse um status fora da lista, a RPC o rejeitaria em runtime
  // (fail-closed) — este assert pega antes, no CI.
  for (const etapa of ["10", "20", "50", "60", "70", "80", "", "99"]) {
    eq(STATUS_GERIDO_OMIE.includes(omieEtapaToStatus(etapa)), true, `etapa ${etapa}`);
  }
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

// ⚠️ Os testes de `diffOrderItens` saíram daqui junto com a função. O diff de itens não é mais
// computado no TS: ele vive dentro de `reconciliar_pedidos_omie` (migration 20260830190000),
// porque um diff computado fora da transação de escrita pode aplicar uma revisão "nova + um
// estranho". A regra — inclusive a tolerância de 1e-6 que este arquivo protegia contra reescrita
// espúria — é provada em `db/test-reconciliar-pedidos-omie.sh` (asserts A1, A9, A13, A16).
