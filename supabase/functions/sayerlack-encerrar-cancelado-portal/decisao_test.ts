// `assertEquals` local em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
function assertEquals(atual: unknown, esperado: unknown) {
  const a = JSON.stringify(atual);
  const e = JSON.stringify(esperado);
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`);
}
import { classificarConsultaPo, motivoRecusaPrevia, type PedidoLido } from "./decisao.ts";

const COD = "AFI-123";
const fault = (f: string, corpo: Record<string, unknown> | null = { faultstring: f }) =>
  ({ status: 500, corpo, faultstring: f });

Deno.test("consulta: PO devolvido = existe (com número)", () => {
  assertEquals(
    classificarConsultaPo({ status: 200, corpo: { cabecalho_consulta: { nCodPed: 555, cNumero: "1291" } }, faultstring: null }, null, COD),
    { tipo: "existe", id: "555", numero: "1291" },
  );
});

Deno.test("consulta: só o fault que nega O PEDIDO e cita o código vira ausente", () => {
  assertEquals(classificarConsultaPo(fault("ERROR: Pedido de compra não cadastrado para o Código de Integração [AFI-123] !"), null, COD).tipo, "ausente");
  assertEquals(classificarConsultaPo(fault("ERROR: Pedido nao encontrado [AFI-123]"), null, COD).tipo, "ausente");
  assertEquals(classificarConsultaPo(fault("Não existe pedido de compra cadastrado com o código de integração AFI-123."), null, COD).tipo, "ausente");
  // o fault INTEIRO vai para a prova (Codex P2)
  const longo = "ERROR:" + " ".repeat(400) + "Pedido de compra não cadastrado [AFI-123]";
  assertEquals(classificarConsultaPo(fault(longo), null, COD), { tipo: "ausente", fault: longo });
});

Deno.test("consulta: fault de OUTRA entidade, sem o código, ou de OUTRO código = indeterminado (Codex desenho P1 #4)", () => {
  // nega o fornecedor, não o pedido — e não cita o código
  assertEquals(classificarConsultaPo(fault("Pedido de compra: fornecedor não cadastrado"), null, COD).tipo, "indeterminado");
  // nega o pedido, mas sem citar o código consultado
  assertEquals(classificarConsultaPo(fault("ERROR: Pedido de compra não cadastrado"), null, COD).tipo, "indeterminado");
  // cita um código que só COMEÇA igual
  assertEquals(classificarConsultaPo(fault("ERROR: Pedido não cadastrado [AFI-1234]"), null, COD).tipo, "indeterminado");
  assertEquals(classificarConsultaPo(fault("Pedido AFI-123 já cadastrado"), null, COD).tipo, "indeterminado");
  // Codex rodada 2, P1: negação de OUTRA coisa com o código citado, e código que só começa igual pela direita
  assertEquals(classificarConsultaPo(fault("Pedido AFI-123: fornecedor não cadastrado"), null, COD).tipo, "indeterminado");
  assertEquals(classificarConsultaPo(fault("Erro ao consultar pedido AFI-123: não existe conexão com o banco"), null, COD).tipo, "indeterminado");
  assertEquals(classificarConsultaPo(fault("ERROR: Pedido não cadastrado [AFI-123-4]"), null, COD).tipo, "indeterminado");
  assertEquals(classificarConsultaPo(fault("ERROR: Pedido não cadastrado [AFI-123] para o fornecedor X"), null, COD).tipo, "indeterminado");
});

Deno.test("consulta: transitório, sem corpo JSON, sem resposta e corpo sem PO = indeterminado", () => {
  assertEquals(classificarConsultaPo(fault("OMIE_TRANSIENT pedido não cadastrado AFI-123"), null, COD).tipo, "indeterminado");
  assertEquals(classificarConsultaPo(fault("Pedido não cadastrado AFI-123", null), null, COD).tipo, "indeterminado");
  assertEquals(classificarConsultaPo(null, "timeout", COD), { tipo: "indeterminado", detalhe: "timeout" });
  assertEquals(classificarConsultaPo({ status: 200, corpo: {}, faultstring: null }, null, COD).tipo, "indeterminado");
  assertEquals(classificarConsultaPo({ status: 503, corpo: { nCodPed: 1 }, faultstring: null }, null, COD).tipo, "indeterminado");
});

const base: PedidoLido = {
  id: 123, empresa: "OBEN", status: "aprovado_aguardando_disparo", status_envio_portal: "sucesso_portal",
  portal_protocolo: "2141001", omie_pedido_compra_id: null, disparo_claim_em: null,
  portal_situacao_codigo: "6", portal_situacao_protocolo: "2141001",
};

Deno.test("prévia: o caso encerrável passa; cada condição recusa com o motivo da RPC", () => {
  assertEquals(motivoRecusaPrevia(base), null);
  assertEquals(motivoRecusaPrevia({ ...base, status: "falha_envio", omie_pedido_compra_id: "0" }), null);
  assertEquals(motivoRecusaPrevia(null), "pedido_nao_encontrado");
  assertEquals(motivoRecusaPrevia({ ...base, empresa: "COLACOR" }), "sem_protocolo_do_portal");
  assertEquals(motivoRecusaPrevia({ ...base, status: "disparado" }), "status_nao_encerravel");
  assertEquals(motivoRecusaPrevia({ ...base, status_envio_portal: "enviado_portal" }), "portal_nao_confirmado");
  assertEquals(motivoRecusaPrevia({ ...base, omie_pedido_compra_id: 9001 }), "tem_po");
  assertEquals(motivoRecusaPrevia({ ...base, portal_situacao_codigo: "1" }), "nao_cancelado_no_portal");
  assertEquals(motivoRecusaPrevia({ ...base, portal_situacao_protocolo: "2141999" }), "nao_cancelado_no_portal");
  assertEquals(motivoRecusaPrevia({ ...base, disparo_claim_em: "2026-11-08T10:00:00Z" }), "disparo_pendente");
});
