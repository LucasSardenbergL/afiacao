// Testa o CÓDIGO REAL de atp-pv-omie.ts (ATP fase 3.3) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/atp-pv-omie_test.ts
//
// Os lados que importam: (1) depois de um envio RECONCILIADO, PV diferente do carrinho ou ilegível
// LANÇA — o vendedor não pode achar que o carrinho atual foi ao Omie; (2) a edição de pedido
// reconciliado divergente é bloqueada; (3) antes de excluir, só a AUSÊNCIA DO PEDIDO afirmada pelo
// Omie libera o DELETE.

import {
  avisoPvReconciliado,
  classificarConsultaExclusao,
  classificarErroConsultaExclusao,
  compararCarrinhoPv,
  compararPrevisaoEntregaPv,
  edicaoBloqueadaPorPvDivergente,
  payloadDoPvReconciliado,
  vereditoExclusaoNoOmie,
} from "./atp-pv-omie.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}
function assertMarca(v: string | null, marca: string, msg: string) {
  if (v === null || !v.includes(marca)) throw new Error(`${msg}: esperava a marca [${marca}], veio ${JSON.stringify(v)}`);
}
const det = (...pares: Array<[unknown, unknown]>) => ({
  pedido_venda_produto: { det: pares.map(([c, q]) => ({ produto: { codigo_produto: c, quantidade: q } })) },
});

Deno.test("comparar: mesmo SKU em várias linhas soma (tintométrico) e bate", () => {
  assertEquals(compararCarrinhoPv(
    [{ omie_codigo_produto: 1, quantidade: 2 }, { omie_codigo_produto: 1, quantidade: 3 }],
    det([1, 5])), "igual", "soma");
  assertEquals(compararCarrinhoPv([{ omie_codigo_produto: 1, quantidade: 0.1 }, { omie_codigo_produto: 1, quantidade: 0.2 }],
    det([1, 0.3])), "igual", "fracionário");
});

Deno.test("comparar: quantidade, SKU a mais ou a menos = divergente", () => {
  assertEquals(compararCarrinhoPv([{ omie_codigo_produto: 1, quantidade: 2 }], det([1, 3])), "divergente", "qtd");
  assertEquals(compararCarrinhoPv([{ omie_codigo_produto: 1, quantidade: 2 }], det([1, 2], [2, 1])), "divergente", "SKU a mais no PV");
  assertEquals(compararCarrinhoPv([{ omie_codigo_produto: 1, quantidade: 2 }, { omie_codigo_produto: 2, quantidade: 1 }], det([1, 2])), "divergente", "SKU a menos no PV");
  assertEquals(compararCarrinhoPv([{ omie_codigo_produto: 2, quantidade: 2 }], det([1, 2])), "divergente", "outro SKU");
});

Deno.test("comparar: qualquer item ilegível torna a leitura inteira ilegível", () => {
  assertEquals(compararCarrinhoPv([{ omie_codigo_produto: 1, quantidade: 2 }], det([1, "2"])), "ilegivel", "qtd string");
  assertEquals(compararCarrinhoPv([{ omie_codigo_produto: 1, quantidade: 2 }], det([1, 2], ["abc", 1])), "ilegivel", "código");
  assertEquals(compararCarrinhoPv([{ omie_codigo_produto: 1, quantidade: 2 }], det([0, 1])), "ilegivel", "código 0");
  assertEquals(compararCarrinhoPv([{ omie_codigo_produto: 1, quantidade: 2 }], { pedido_venda_produto: { det: {} } }), "ilegivel", "det objeto");
  assertEquals(compararCarrinhoPv([{ omie_codigo_produto: 1, quantidade: 2 }], null), "ilegivel", "sem consulta");
  assertEquals(compararCarrinhoPv([{ omie_codigo_produto: 1, quantidade: 2 }], { det: [{ produto: { codigo_produto: 1, quantidade: 2 } }] }), "igual", "forma consulta.det");
});

Deno.test("aviso: divergente e ilegível LANÇAM com o PID e 'não reenvie'", () => {
  const d = avisoPvReconciliado("divergente", { ok: true, reserva_ajustada: true }, 9301);
  assertMarca(d, "tentativa anterior", "divergente");
  assertMarca(d, "PV 9301", "divergente cita o PID");
  assertMarca(d, "não reenvie", "divergente proíbe reenvio");
  assertMarca(d, "passou a ser a do pedido do Omie", "divergente com reserva ajustada diz isso");
  assertMarca(avisoPvReconciliado("ilegivel", { ok: true }, 9303), "não deu para conferir", "ilegível");
});

Deno.test("aviso: backorder divergente (sem reserva) não afirma reserva ajustada", () => {
  const d = avisoPvReconciliado("divergente", { ok: true, reserva_ajustada: false, ajuste_falhou: null }, 9310);
  assertMarca(d, "tentativa anterior", "divergente");
  if (d !== null && d.includes("reserva de estoque passou")) throw new Error(`afirmou reserva inexistente: ${d}`);
});

Deno.test("aviso: falha do ajuste NUNCA é escondida pela divergência", () => {
  const d = avisoPvReconciliado("divergente", { ok: true, ajuste_falhou: "23505: duplicate key" }, 9311);
  assertMarca(d, "tentativa anterior", "divergente");
  assertMarca(d, "NÃO pôde ser conferida", "falha visível");
  if (d !== null && d.includes("passou a ser a do pedido")) throw new Error(`afirmou ajuste que falhou: ${d}`);
  assertMarca(avisoPvReconciliado("igual", { ok: true, ajuste_falhou: "40P01: deadlock" }, 9305), "NÃO pôde ser conferida", "falha com PV igual");
});

Deno.test("aviso: PV igual segue em silêncio (com ou sem ajuste de reserva)", () => {
  assertEquals(avisoPvReconciliado("igual", { ok: true, reserva_ajustada: false, ajuste_falhou: null }, 9302), null, "igual");
  assertEquals(avisoPvReconciliado("igual", { ok: true, reserva_ajustada: true, ajuste_falhou: null }, 9302), null, "igual ajustado");
  assertEquals(avisoPvReconciliado("igual", null, 9302), null, "banco sem a 3.3");
});

Deno.test("edição: bloqueada só quando o PV reconciliado diverge dos itens gravados", () => {
  const itens = [{ omie_codigo_produto: 1, quantidade: 2 }];
  assertEquals(edicaoBloqueadaPorPvDivergente({ reconciled: true, consulta: det([1, 3]) }, itens), true, "divergente");
  assertEquals(edicaoBloqueadaPorPvDivergente({ reconciled: true, consulta: det([1, "x"]) }, itens), true, "ilegível bloqueia");
  assertEquals(edicaoBloqueadaPorPvDivergente({ reconciled: true, consulta: det([1, 2]) }, itens), false, "igual");
  assertEquals(edicaoBloqueadaPorPvDivergente({ codigo_pedido: 1 }, itens), false, "envio normal");
  assertEquals(edicaoBloqueadaPorPvDivergente(null, itens), false, "sem resposta");
  const comS = { reconciled: true, consulta: { pedido_venda_produto: { det: [{ produto: { codigo_produto: 1, quantidade: 2 }, inf_adic: { nao_movimentar_estoque: "S" } }] } } };
  assertEquals(edicaoBloqueadaPorPvDivergente(comS, itens), true, "PV com item que não movimenta estoque");
});

Deno.test("consulta: null (EOF 'Não existem registros') = ausente", () => {
  assertEquals(classificarConsultaExclusao(null), { tipo: "ausente" }, "null");
});

Deno.test("consulta: as duas formas da resposta com código = existe (e carrega a consulta)", () => {
  const a = classificarConsultaExclusao({ pedido_venda_produto: { cabecalho: { codigo_pedido: 777 } } });
  assertEquals(a.tipo === "existe" && a.codigoPedido, 777, "pedido_venda_produto");
  const b = classificarConsultaExclusao({ cabecalho: { codigo_pedido: 778 } });
  assertEquals(b.tipo === "existe" && b.codigoPedido, 778, "cabecalho");
});

Deno.test("consulta: resposta sem código válido = indeterminado (nunca ausente)", () => {
  for (const r of [{}, { cabecalho: {} }, { cabecalho: { codigo_pedido: 0 } }, { cabecalho: { codigo_pedido: "777" } }, undefined]) {
    assertEquals(classificarConsultaExclusao(r).tipo, "indeterminado", JSON.stringify(r ?? "undefined"));
  }
});

Deno.test("erro: fault que afirma ausência DO PEDIDO = ausente", () => {
  for (const m of [
    "Erro Omie Vendas (oben): ERROR: Pedido não cadastrado para o Código de Integração [PV_x] !",
    "Erro Omie Vendas (oben): Pedido de venda nao encontrado",
  ]) {
    assertEquals(classificarErroConsultaExclusao(new Error(m)).tipo, "ausente", m);
  }
});

Deno.test("erro: outra entidade, duplicata, transitório e desconhecido = indeterminado", () => {
  for (const m of [
    "Erro Omie Vendas (oben): Aplicativo não encontrado",
    "Erro Omie Vendas (oben): Cliente não cadastrado",
    "Erro Omie Vendas (oben): Não existem permissões para consultar pedidos",
    "Erro Omie Vendas (oben): Pedido já cadastrado para o Código de Integração [PV_x]",
    "OMIE_TRANSIENT (oben): rate limit persistiu após 3 tentativas — não dá pra afirmar ausência",
    "Erro Omie Vendas (oben): HTTP 500",
    "fetch failed",
  ]) {
    assertEquals(classificarErroConsultaExclusao(new Error(m)).tipo, "indeterminado", m);
  }
});

Deno.test("exclusão no Omie: registro importado nunca sai pelo app", () => {
  const v = vereditoExclusaoNoOmie({ hashPayload: "omie_oben_9001", omiePedidoId: 9001, statusCanonico: "cancelado" });
  assertEquals(v.permitido, false, "importado mesmo cancelado");
  assertMarca(v.permitido ? null : v.motivo, "Registro importado do Omie", "marca");
  assertMarca(v.permitido ? null : v.motivo, "inclusive os cancelados", "explica que importado fica");
});

Deno.test("exclusão no Omie: pedido do app só sai com a canônica CANCELADA", () => {
  assertEquals(vereditoExclusaoNoOmie({ hashPayload: null, omiePedidoId: 9002, statusCanonico: "cancelado" }), { permitido: true }, "cancelado");
  for (const st of [null, "importado", "enviado", "separacao", "faturado", "CANCELADO"]) {
    const v = vereditoExclusaoNoOmie({ hashPayload: null, omiePedidoId: 9002, statusCanonico: st });
    assertEquals(v.permitido, false, String(st));
    assertMarca(v.permitido ? null : v.motivo, "Cancele direto no Omie", String(st));
    assertMarca(v.permitido ? null : v.motivo, "avise o suporte", String(st));
  }
});

// ── PR 2.5 (rodada 3, "reenvio honesto"): a previsão de entrega do PV reconciliado ──
const comFrete = (frete: unknown) => ({ pedido_venda_produto: { cabecalho: { codigo_pedido: 1 }, frete } });

Deno.test("previsão: campo AUSENTE na resposta = não conferível, nunca igual", () => {
  assertEquals(compararPrevisaoEntregaPv("10/12/2026", { pedido_venda_produto: { cabecalho: {} } }), { estado: "nao_conferivel" }, "sem frete");
  assertEquals(compararPrevisaoEntregaPv("10/12/2026", comFrete({ modalidade: "0" })), { estado: "nao_conferivel" }, "frete sem a chave");
  assertEquals(compararPrevisaoEntregaPv(null, comFrete({ modalidade: "0" })), { estado: "nao_conferivel" }, "sem data dos dois lados e chave ausente");
  assertEquals(compararPrevisaoEntregaPv("10/12/2026", comFrete({ previsao_entrega: null })), { estado: "nao_conferivel" }, "null");
  assertEquals(compararPrevisaoEntregaPv("10/12/2026", null), { estado: "nao_conferivel" }, "consulta nula");
});

Deno.test("previsão: data legível compara o DIA (dd/mm/aaaa e aaaa-mm-dd)", () => {
  assertEquals(compararPrevisaoEntregaPv("10/12/2026", comFrete({ previsao_entrega: "10/12/2026" })), { estado: "igual" }, "mesmo dia");
  assertEquals(compararPrevisaoEntregaPv("10/12/2026", comFrete({ previsao_entrega: "2026-12-10" })), { estado: "igual" }, "ISO");
  assertEquals(compararPrevisaoEntregaPv("10/12/2026", { frete: { previsao_entrega: "10/12/2026" } }), { estado: "igual" }, "forma sem pedido_venda_produto");
  assertEquals(
    compararPrevisaoEntregaPv("10/12/2026", comFrete({ previsao_entrega: "05/12/2026" })),
    { estado: "divergente", noOmie: "05/12/2026", enviada: "10/12/2026" },
    "outro dia",
  );
});

Deno.test("previsão: vazio no Omie = PV sem data (igual sem data, divergente com data)", () => {
  assertEquals(compararPrevisaoEntregaPv(null, comFrete({ previsao_entrega: "" })), { estado: "igual" }, "nenhum dos dois");
  assertEquals(compararPrevisaoEntregaPv("", comFrete({ previsao_entrega: "  " })), { estado: "igual" }, "vazios");
  assertEquals(
    compararPrevisaoEntregaPv("10/12/2026", comFrete({ previsao_entrega: "" })),
    { estado: "divergente", noOmie: null, enviada: "10/12/2026" },
    "envio com data, PV sem",
  );
  assertEquals(
    compararPrevisaoEntregaPv(null, comFrete({ previsao_entrega: "05/12/2026" })),
    { estado: "divergente", noOmie: "05/12/2026", enviada: null },
    "envio sem data, PV com",
  );
});

Deno.test("previsão: texto ilegível ou dia inexistente = não conferível", () => {
  for (const v of ["10-12-2026", "31/02/2026", "amanhã", "10/12/26", "00/12/2026"]) {
    assertEquals(compararPrevisaoEntregaPv("10/12/2026", comFrete({ previsao_entrega: v })), { estado: "nao_conferivel" }, v);
  }
  assertEquals(compararPrevisaoEntregaPv("31/02/2026", comFrete({ previsao_entrega: "10/12/2026" })), { estado: "nao_conferivel" }, "enviada ilegível");
});

Deno.test("aviso: itens iguais e previsão DIVERGENTE LANÇA com a data do Omie", () => {
  const d = avisoPvReconciliado("igual", { ok: true }, 9401, { estado: "divergente", noOmie: "05/12/2026", enviada: "10/12/2026" });
  assertMarca(d, "PV 9401", "pid");
  assertMarca(d, "ficou 05/12/2026", "data do Omie");
  assertMarca(d, "(10/12/2026)", "data do envio");
  assertMarca(d, "Corrija a previsão de entrega direto no Omie", "instrução");
  assertMarca(d, "não reenvie", "não reenvie");
  const semData = avisoPvReconciliado("igual", { ok: true }, 9402, { estado: "divergente", noOmie: null, enviada: "10/12/2026" });
  assertMarca(semData, "SEM previsão de entrega", "PV sem data");
});

Deno.test("aviso: previsão não conferível LANÇA (ausente ≠ igual)", () => {
  const d = avisoPvReconciliado("igual", { ok: true, reserva_ajustada: true }, 9403, { estado: "nao_conferivel" });
  assertMarca(d, "Não deu para conferir a previsão de entrega", "frase");
  assertMarca(d, "Confira no Omie a previsão de entrega", "instrução");
});

Deno.test("aviso: itens E data divergentes — uma frase não esconde a outra", () => {
  const d = avisoPvReconciliado("divergente", { ok: true, ajuste_falhou: "40P01" }, 9404, { estado: "divergente", noOmie: "05/12/2026", enviada: "10/12/2026" });
  assertMarca(d, "diferentes do carrinho atual", "itens");
  assertMarca(d, "ficou 05/12/2026", "data");
  assertMarca(d, "NÃO pôde ser conferida (40P01)", "reserva");
  assertMarca(d, "Corrija os itens e a previsão de entrega", "instrução");
  const misto = avisoPvReconciliado("divergente", { ok: true }, 9405, { estado: "nao_conferivel" });
  assertMarca(misto, "Corrija os itens e confira a previsão de entrega direto no Omie", "corrige e confere");
});

Deno.test("aviso: previsão igual mantém o silêncio e o texto da 3.3", () => {
  assertEquals(avisoPvReconciliado("igual", { ok: true, reserva_ajustada: true }, 9406, { estado: "igual" }), null, "tudo igual");
  assertEquals(
    avisoPvReconciliado("divergente", { ok: true }, 9407, { estado: "igual" }),
    avisoPvReconciliado("divergente", { ok: true }, 9407),
    "data igual não muda a frase dos itens",
  );
});

Deno.test("payload gravado: o PV que o Omie TEM, nunca o recusado", () => {
  const pvp = { cabecalho: { codigo_pedido: 7, codigo_parcela: "001" }, det: [], frete: { previsao_entrega: "05/12/2026" } };
  assertEquals(payloadDoPvReconciliado({ pedido_venda_produto: pvp }), pvp, "pedido_venda_produto");
  assertEquals(payloadDoPvReconciliado({ cabecalho: { codigo_pedido: 7 } }), { cabecalho: { codigo_pedido: 7 } }, "forma plana");
  assertEquals(payloadDoPvReconciliado({ algo: 1 }), null, "sem forma");
  assertEquals(payloadDoPvReconciliado(null), null, "nulo");
  assertEquals(payloadDoPvReconciliado({ pedido_venda_produto: [1] }), null, "array");
});
