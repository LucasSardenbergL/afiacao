// Canon de omie-pedido.ts (#B). Roda: deno test supabase/functions/_shared/omie-pedido_test.ts
import {
  omieEtapaToStatus,
  etapaConhecida,
  subtotalPedidoComDesconto,
  construirItemsJson,
  precoUnitarioOmie,
  contarItensSemPreco,
  mesclarPrecoPreservado,
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

// ── Preço ausente ≠ preço zero (a fatia da origem, 2026-09-05) ────────────────────────────────
// Gêmeo TS da régua SQL de `criar_pedidos_com_itens` (migration 20260905225613). Os dois têm de
// concordar item a item, senão a edge manda um número que a RPC classifica de outro jeito.
Deno.test("precoUnitarioOmie: finitude NÃO-NEGATIVA — separa 'não informou' de 'informou 0'", () => {
  eq(precoUnitarioOmie(undefined), null, "ausente");
  eq(precoUnitarioOmie(null), null, "null");
  eq(precoUnitarioOmie(""), null, "string vazia");
  eq(precoUnitarioOmie("   "), null, "só espaço");
  eq(precoUnitarioOmie({}), null, "objeto");
  eq(precoUnitarioOmie([]), null, "array (Number([]) é 0 — não pode virar preço)");
  eq(precoUnitarioOmie(false), null, "boolean (Number(false) é 0)");
  eq(precoUnitarioOmie("abc"), null, "lixo");
  eq(precoUnitarioOmie(-5), null, "negativo é corrupção, não desconto");
  eq(precoUnitarioOmie(Number.NaN), null, "NaN");
  eq(precoUnitarioOmie(Number.POSITIVE_INFINITY), null, "Infinity");
  // O ponto da fatia: 0 é FATO, não ausência. Quem exclui o 0 da margem é o consumo (SQL `> 0`).
  eq(precoUnitarioOmie(0), 0, "zero informado é dado (bonificação/brinde)");
  eq(precoUnitarioOmie("0"), 0, "zero como string");
  eq(precoUnitarioOmie(13.85), 13.85, "preço bom");
  eq(precoUnitarioOmie("13.85"), 13.85, "preço bom como string (o jsonb devolve assim)");
});

Deno.test("subtotal: item SEM preço fica de fora (soma idêntica, incompletude visível)", () => {
  // Somar `qty·0` e omitir o item dão o MESMO número — o subtotal não muda, e é por isso que
  // ele não podia ser o sensor. O sensor é contarItensSemPreco / o null no items-jsonb.
  eq(subtotalPedidoComDesconto([
    { produto: { quantidade: 2, valor_unitario: 10 } },
    { produto: { quantidade: 5 } },
  ]), 20, "item sem preço não soma nada");
  eq(contarItensSemPreco([
    { produto: { quantidade: 2, valor_unitario: 10 } },
    { produto: { quantidade: 5 } },
  ]), 1, "e a ausência é CONTADA");
  eq(subtotalPedidoComDesconto([{ produto: { quantidade: 2, valor_unitario: 0 } }]), 0, "zero informado soma 0");
  eq(contarItensSemPreco([{ produto: { quantidade: 2, valor_unitario: 0 } }]), 0, "zero informado NÃO é ausência");
  eq(contarItensSemPreco([{ produto: { quantidade: 1, valor_unitario: -3 } }]), 1, "lixo conta como ausência");
});

Deno.test("construirItemsJson: preço ausente vira null no jsonb, não 0", () => {
  const out = construirItemsJson([
    { produto: { codigo_produto: 8, descricao: "PINO", quantidade: 3 } },
    { produto: { codigo_produto: 9, descricao: "BASE", quantidade: 1, valor_unitario: 0 } },
  ]);
  eq(out[0].valor_unitario, null, "ausente → null (os leitores mostram '—')");
  eq(out[1].valor_unitario, 0, "zero informado → 0 (os leitores mostram R$ 0,00)");
});

Deno.test("mesclarPrecoPreservado: o preço GRAVADO vence; a leitura nova nunca rebaixa", () => {
  const novos = [
    { omie_codigo_produto: 1, valor_unitario: null },
    { omie_codigo_produto: 2, valor_unitario: 50 },
    { omie_codigo_produto: 3, valor_unitario: null },
  ];
  const gravados = [
    { omie_codigo_produto: 1, valor_unitario: 99 },   // o Omie esqueceu; o banco lembra
    { omie_codigo_produto: 2, valor_unitario: 10 },   // leitura nova sabe → ela vence
    { omie_codigo_produto: 9, valor_unitario: 77 },   // item que não existe mais
  ];
  const out = mesclarPrecoPreservado(novos, gravados);
  eq(out[0].valor_unitario, 99, "preço bom preservado (era o bug: seria APAGADO)");
  eq(out[1].valor_unitario, 50, "leitura nova com preço não é sobrescrita pelo gravado");
  eq(out[2].valor_unitario, null, "sem correspondente gravado, segue não sabido");
  // Degradações que não podem virar exceção nem fabricar número:
  eq(mesclarPrecoPreservado(novos, null)[0].valor_unitario, null, "gravados não-array → passa direto");
  eq(mesclarPrecoPreservado(novos, [])[0].valor_unitario, null, "gravados vazio → passa direto");
  eq(mesclarPrecoPreservado(novos, [{ omie_codigo_produto: 1, valor_unitario: -1 }])[0].valor_unitario, null,
     "gravado LIXO não é preservado (seria promover corrupção a verdade)");
  eq(mesclarPrecoPreservado(novos, [{ omie_codigo_produto: "1", valor_unitario: 42 }])[0].valor_unitario, 42,
     "casa por código mesmo com tipos diferentes (o jsonb devolve number, o Omie manda string)");
  // AMBIGUIDADE: com o código repetido não há como saber qual preço pertence a qual linha.
  // Aplicar o primeiro aos dois espalha um preço para uma linha que talvez nunca o teve —
  // precisão > recall: fica `null`. [P1 do challenge Codex]
  eq(mesclarPrecoPreservado(novos, [
       { omie_codigo_produto: 1, valor_unitario: 5 },
       { omie_codigo_produto: 1, valor_unitario: 6 },
     ])[0].valor_unitario, null, "código repetido nos GRAVADOS: não adivinha");
  eq(mesclarPrecoPreservado(
       [{ omie_codigo_produto: 7, valor_unitario: null }, { omie_codigo_produto: 7, valor_unitario: null }],
       [{ omie_codigo_produto: 7, valor_unitario: 30 }],
     ).map((x) => x.valor_unitario), [null, null],
     "código repetido nos NOVOS: um preço gravado não vira dois");
  // E o caso normal segue funcionando (a ambiguidade não pode ter matado a mescla).
  eq(mesclarPrecoPreservado(
       [{ omie_codigo_produto: 3, valor_unitario: null }],
       [{ omie_codigo_produto: 3, valor_unitario: 30 }],
     )[0].valor_unitario, 30, "código único: preserva normalmente");
});
