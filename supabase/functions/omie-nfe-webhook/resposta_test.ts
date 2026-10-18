// Testa a tradução desfecho da RPC → HTTP do webhook (resposta.ts) no Deno, `--no-remote`.
import { responderDesfecho } from "./resposta.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const ID = "6f4b0a2e-0000-4000-8000-000000000001";
const CHAVE = "35261012345678000190550010000000011000000011";

Deno.test("2xx SÓ com itens gravados: importada, reparada e ja_importada", () => {
  const imp = responderDesfecho({ tipo: "importada", id: ID, itens: 3 }, CHAVE);
  assertEquals([imp.status, imp.corpo], [200, { success: true, nfe_recebimento_id: ID, itens_count: 3 }]);
  const rep = responderDesfecho({ tipo: "reparada", id: ID, itens: 2 }, CHAVE);
  assertEquals([rep.status, rep.corpo.reparado, rep.corpo.itens_count], [200, true, 2]);
  const ja = responderDesfecho({ tipo: "ja_importada", id: ID, itens: 3 }, CHAVE);
  assertEquals([ja.status, ja.corpo], [200, { message: "já importada", id: ID, itens_count: 3 }]);
});

Deno.test("bloqueada e divergente são 409 (não-2xx: o Omie reenvia/DLQ), com o motivo em details", () => {
  const b = responderDesfecho({ tipo: "bloqueada", id: ID, itens: 0, motivo: "status efetivado" }, CHAVE);
  assertEquals([b.status, b.corpo.nfe_recebimento_id, b.corpo.details, b.log.nivel], [409, ID, "status efetivado", "error"]);
  const d = responderDesfecho({ tipo: "divergente", id: ID, itens: 3, esperados: 2, motivo: "cardinalidade" }, CHAVE);
  assertEquals([d.status, d.corpo.itens_count, d.corpo.itens_payload, d.corpo.details], [409, 3, 2, "cardinalidade"]);
});

Deno.test("erro de DADO é 422 com código, motivo e as tentativas registradas (null = ledger não gravou)", () => {
  const r = responderDesfecho({ tipo: "erro", classe: "dado", code: "NFE02", mensagem: "sequencia repetida" }, CHAVE, 2);
  assertEquals([r.status, r.corpo.code, r.corpo.details, r.corpo.tentativas_registradas], [422, "NFE02", "sequencia repetida", 2]);
  const semLedger = responderDesfecho({ tipo: "erro", classe: "dado", code: "22001", mensagem: "value too long" }, CHAVE, null);
  assertEquals([semLedger.status, semLedger.corpo.tentativas_registradas], [422, null]);
  if (!semLedger.log.texto.includes("NÃO registrou")) throw new Error("o log tem de dizer que o ledger não gravou");
});

Deno.test("RPC ausente é 500 e o corpo NOMEIA a migration — nunca cai no caminho antigo", () => {
  const r = responderDesfecho({ tipo: "erro", classe: "rpc_ausente", code: "PGRST202", mensagem: "Could not find the function" }, CHAVE);
  assertEquals(r.status, 500);
  if (!String(r.corpo.error).includes("2026-10-18-importar-nfe-recebimento-rpc.sql")) throw new Error("tem de apontar a migration");
  if (!r.log.texto.includes("ANTES da migration")) throw new Error("o log tem de dizer que foi deploy fora de ordem");
});

Deno.test("erro de infra é 500 e diz que o reenvio repete a importação inteira (transação: nada ficou)", () => {
  const r = responderDesfecho({ tipo: "erro", classe: "infra", code: "57014", mensagem: "canceling statement" }, CHAVE);
  assertEquals([r.status, r.corpo.code], [500, "57014"]);
  if (!String(r.corpo.error).includes("repete a importação inteira")) throw new Error("mensagem do 500 de infra");
});
