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
  edicaoBloqueadaPorPvDivergente,
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
  const d = avisoPvReconciliado("divergente", { ok: true }, 9301);
  assertMarca(d, "tentativa anterior", "divergente");
  assertMarca(d, "PV 9301", "divergente cita o PID");
  assertMarca(d, "não reenvie", "divergente proíbe reenvio");
  assertMarca(avisoPvReconciliado("ilegivel", { ok: true }, 9303), "não deu para conferir", "ilegível");
});

Deno.test("aviso: ajuste de reserva que falhou no banco LANÇA mesmo com PV igual", () => {
  assertMarca(avisoPvReconciliado("igual", { ok: true, ajuste_falhou: "23505: duplicate key" }, 9305), "não pôde ser conferida", "falha");
});

Deno.test("aviso: PV igual e reserva ok segue em silêncio", () => {
  assertEquals(avisoPvReconciliado("igual", { ok: true, reserva_ajustada: false, ajuste_falhou: null }, 9302), null, "igual");
  assertEquals(avisoPvReconciliado("igual", null, 9302), null, "banco sem a 3.3");
});

Deno.test("edição: bloqueada só quando o PV reconciliado diverge dos itens gravados", () => {
  const itens = [{ omie_codigo_produto: 1, quantidade: 2 }];
  assertEquals(edicaoBloqueadaPorPvDivergente({ reconciled: true, consulta: det([1, 3]) }, itens), true, "divergente");
  assertEquals(edicaoBloqueadaPorPvDivergente({ reconciled: true, consulta: det([1, "x"]) }, itens), true, "ilegível bloqueia");
  assertEquals(edicaoBloqueadaPorPvDivergente({ reconciled: true, consulta: det([1, 2]) }, itens), false, "igual");
  assertEquals(edicaoBloqueadaPorPvDivergente({ codigo_pedido: 1 }, itens), false, "envio normal");
  assertEquals(edicaoBloqueadaPorPvDivergente(null, itens), false, "sem resposta");
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
