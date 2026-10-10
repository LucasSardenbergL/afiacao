// Testa o CÓDIGO REAL de atp-pv-omie.ts (ATP fase 3.3) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/atp-pv-omie_test.ts
//
// Os dois lados que importam: (1) depois de um envio RECONCILIADO, divergência ou leitura
// ilegível LANÇAM — o vendedor não pode achar que o carrinho atual foi ao Omie; (2) antes de
// excluir um pedido sem PID, só a AUSÊNCIA AFIRMADA pelo Omie libera o DELETE — transitório,
// fault desconhecido e resposta sem código recusam.

import {
  avisoPvReconciliado,
  classificarConsultaExclusao,
  classificarErroConsultaExclusao,
} from "./atp-pv-omie.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}
function assertMarca(v: string | null, marca: string, msg: string) {
  if (v === null || !v.includes(marca)) throw new Error(`${msg}: esperava a marca [${marca}], veio ${JSON.stringify(v)}`);
}

Deno.test("aviso: PV divergente LANÇA com o PID e a instrução de não reenviar", () => {
  const v = avisoPvReconciliado({ ok: true, pv_divergente: true, pv_itens_legiveis: true }, 9301);
  assertMarca(v, "tentativa anterior", "divergente");
  assertMarca(v, "PV 9301", "divergente cita o PID");
  assertMarca(v, "não reenvie", "divergente proíbe reenvio");
});

Deno.test("aviso: itens ilegíveis LANÇAM (não se afirma que bate)", () => {
  const v = avisoPvReconciliado({ ok: true, pv_divergente: false, pv_itens_legiveis: false }, 9303);
  assertMarca(v, "não deu para conferir", "ilegível");
});

Deno.test("aviso: PV igual à reserva segue em silêncio", () => {
  assertEquals(avisoPvReconciliado({ ok: true, pv_divergente: false, pv_itens_legiveis: true }, 9302), null, "igual");
});

Deno.test("aviso: banco sem a 3.3 (campos ausentes) não inventa divergência", () => {
  assertEquals(avisoPvReconciliado({ ok: true, reservas_firmadas: 1 }, 9300), null, "sem campos");
  assertEquals(avisoPvReconciliado(null, 9300), null, "null");
  // "true" string não é true: o contrato é booleano
  assertEquals(avisoPvReconciliado({ pv_divergente: "true" }, 9300), null, "string");
});

Deno.test("consulta: null (EOF 'Não existem registros') = ausente", () => {
  assertEquals(classificarConsultaExclusao(null), { tipo: "ausente" }, "null");
});

Deno.test("consulta: as duas formas da resposta com código = existe", () => {
  assertEquals(classificarConsultaExclusao({ pedido_venda_produto: { cabecalho: { codigo_pedido: 777 } } }),
    { tipo: "existe", codigoPedido: 777 }, "pedido_venda_produto");
  assertEquals(classificarConsultaExclusao({ cabecalho: { codigo_pedido: 778 } }),
    { tipo: "existe", codigoPedido: 778 }, "cabecalho");
});

Deno.test("consulta: resposta sem código válido = indeterminado (nunca ausente)", () => {
  for (const r of [{}, { cabecalho: {} }, { cabecalho: { codigo_pedido: 0 } }, { cabecalho: { codigo_pedido: "777" } }, undefined]) {
    assertEquals(classificarConsultaExclusao(r).tipo, "indeterminado", JSON.stringify(r ?? "undefined"));
  }
});

Deno.test("erro: fault que afirma ausência = ausente", () => {
  for (const m of [
    "Erro Omie Vendas (oben): ERROR: Pedido não cadastrado para o Código de Integração [PV_x] !",
    "Erro Omie Vendas (oben): Pedido de venda nao encontrado",
    "Erro Omie Vendas (oben): O pedido informado não existe",
  ]) {
    assertEquals(classificarErroConsultaExclusao(new Error(m)).tipo, "ausente", m);
  }
});

Deno.test("erro: duplicata, transitório e fault desconhecido = indeterminado", () => {
  for (const m of [
    "Erro Omie Vendas (oben): Pedido já cadastrado para o Código de Integração [PV_x]",
    "OMIE_TRANSIENT (oben): rate limit persistiu após 3 tentativas — não dá pra afirmar ausência",
    "Erro Omie Vendas (oben): HTTP 500",
    "fetch failed",
  ]) {
    assertEquals(classificarErroConsultaExclusao(new Error(m)).tipo, "indeterminado", m);
  }
});
