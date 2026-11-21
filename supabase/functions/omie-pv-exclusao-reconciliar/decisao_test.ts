// `assertEquals` local em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
function assertEquals(atual: unknown, esperado: unknown) {
  const a = JSON.stringify(atual);
  const e = JSON.stringify(esperado);
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`);
}
import { lerResposta } from "../_shared/omie-cliente.ts";
import { classificarConsulta, classificarErro } from "./decisao.ts";

const PID = 12156020937;
const resp = (status: number, corpo: unknown) => lerResposta(status, JSON.stringify(corpo));
const tipo = (r: ReturnType<typeof resp>, pid = PID) => classificarConsulta(r, pid).tipo;

// Texto REAL do Omie (ConsultarPedido do PV 12231, excluído — medido 2026-11-21).
const FAULT_REAL = `ERROR: Pedido não cadastrado para o Código [${PID}] !`;

Deno.test("ausente: fault real do Omie com o código consultado", () => {
  const c = classificarConsulta(resp(500, { faultstring: FAULT_REAL, faultcode: "SOAP-ENV:Client-103" }), PID);
  assertEquals(c.tipo, "ausente");
});

Deno.test("indeterminado: negação que cita OUTRO código", () => {
  assertEquals(tipo(resp(500, { faultstring: "ERROR: Pedido não cadastrado para o Código [999] !" })), "indeterminado");
});

Deno.test("indeterminado: negação sem código nenhum", () => {
  assertEquals(tipo(resp(500, { faultstring: "ERROR: Pedido não cadastrado!" })), "indeterminado");
});

Deno.test("indeterminado: código consultado como PREFIXO de outro não casa", () => {
  assertEquals(tipo(resp(500, { faultstring: `ERROR: Pedido não cadastrado para o Código [${PID}9] !` })), "indeterminado");
});

Deno.test("indeterminado: fault de outra entidade cita o código", () => {
  assertEquals(tipo(resp(500, { faultstring: `ERROR: Cliente não cadastrado para o Código [${PID}] !` })), "indeterminado");
  assertEquals(tipo(resp(500, { faultstring: `ERROR: Aplicativo não encontrado [${PID}]` })), "indeterminado");
});

Deno.test("indeterminado: transitório / rate limit / 5xx sem fault / corpo ilegível", () => {
  assertEquals(tipo(resp(500, { faultstring: "Broken response from SOAP server" })), "indeterminado");
  assertEquals(tipo(resp(500, { faultstring: "ERROR: Já existe uma requisição desse método sendo executada" })), "indeterminado");
  assertEquals(tipo(lerResposta(429, "")), "indeterminado");
  assertEquals(tipo(lerResposta(502, "<html>bad gateway</html>")), "indeterminado");
  assertEquals(tipo(lerResposta(200, "{corte")), "indeterminado");
});

Deno.test("existe: cabeçalho com o MESMO codigo_pedido", () => {
  const c = classificarConsulta(resp(200, {
    pedido_venda_produto: { cabecalho: { codigo_pedido: PID, numero_pedido: "12231", etapa: "10" }, infoCadastro: { cancelado: "N" } },
  }), PID);
  assertEquals(c, { tipo: "existe", codigoPedido: PID, numeroPedido: "12231", etapa: "10", cancelado: "N" });
});

Deno.test("indeterminado: 200 com OUTRO codigo_pedido ou sem cabeçalho", () => {
  assertEquals(tipo(resp(200, { pedido_venda_produto: { cabecalho: { codigo_pedido: 1 } } })), "indeterminado");
  assertEquals(tipo(resp(200, { pedido_venda_produto: { cabecalho: { codigo_pedido: String(PID) } } })), "indeterminado");
  assertEquals(tipo(resp(200, {})), "indeterminado");
});

Deno.test("indeterminado: código consultado inválido nunca vira ausência", () => {
  assertEquals(tipo(resp(500, { faultstring: "ERROR: Pedido não cadastrado para o Código [0] !" }), 0), "indeterminado");
});

Deno.test("exceção de transporte é indeterminado", () => {
  assertEquals(classificarErro("OMIE_TRANSIENT timeout").tipo, "indeterminado");
});
