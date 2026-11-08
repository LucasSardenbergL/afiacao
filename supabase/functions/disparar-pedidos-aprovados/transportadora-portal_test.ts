import { igual } from "../_shared/harness-handler_test.ts";
import { montarObservacaoPo, transportadoraDosItensBrutos } from "./transportadora-portal.ts";

Deno.test("transportadora: lê data_pedido.transportadora do retorno cru e limpa espaços", () => {
  igual(transportadoraDosItensBrutos({ success: true, itens: [], data_pedido: { transportadora: "  SP  MINAS " } }), "SP MINAS", "nome limpo");
});

Deno.test("transportadora: ausente, vazia, não-texto, com controle ou longa demais = null (nunca inventada)", () => {
  for (const v of [null, undefined, "x", [], {}, { data_pedido: null }, { data_pedido: [] }, { data_pedido: {} },
    { data_pedido: { transportadora: "" } }, { data_pedido: { transportadora: "   " } }, { data_pedido: { transportadora: 42 } },
    { data_pedido: { transportadora: "SP\u0000MINAS" } }, { data_pedido: { transportadora: "x".repeat(61) } }]) {
    igual(transportadoraDosItensBrutos(v), null, String(JSON.stringify(v)));
  }
});

Deno.test("observação do PO: com transportadora acrescenta a linha; sem, fica a base intacta", () => {
  igual(montarObservacaoPo("Base", "SPMINAS"), "Base · Transportadora (portal Sayerlack): SPMINAS", "com transportadora");
  igual(montarObservacaoPo("Base", null), "Base", "sem transportadora");
});
