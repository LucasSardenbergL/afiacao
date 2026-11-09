// 5.2 (revisão 2, fatia 1): a leitura vai inteira à RPC e a resposta fora do contrato LANÇA (fail-closed).
import { igual } from "../_shared/harness-handler_test.ts";
import { conferirPortal, interpretarConferencia, mensagemRecusa, montarLeitura, resumoDiferencas } from "./conferencia.ts";

const assertEquals = (atual: unknown, esperado: unknown) => igual(atual, esperado, "valor");
/** Lança E a mensagem contém o trecho do RAMO esperado (nunca "lançou algo"). */
function assertThrows(fn: () => unknown, _tipo: unknown, trecho: string) {
  let msg: string | null = null;
  try { fn(); } catch (e) { msg = (e as Error).message; }
  if (msg === null) throw new Error(`esperava lançar "${trecho}", não lançou`);
  if (!msg.includes(trecho)) throw new Error(`lançou outra coisa: "${msg}" (esperava "${trecho}")`);
}

Deno.test("montarLeitura leva itens, total, condição e o intervalo da observação", () => {
  const l = montarLeitura("2140603", [{ sku_portal: "A", qtde_portal: 2, valor_mercadoria: 10 }], 12.5, "70 - 7 DIAS",
    "2026-11-09T10:00:00Z", "2026-11-09T10:01:00Z");
  assertEquals(l, {
    protocolo: "2140603", condicao: "70 - 7 DIAS", valor_total: 12.5,
    itens: [{ sku_portal: "A", qtde_portal: 2, valor_mercadoria: 10 }],
    lido_de: "2026-11-09T10:00:00Z", lido_ate: "2026-11-09T10:01:00Z",
  });
});

Deno.test("interpretarConferencia: bate, divergente e recusada", () => {
  assertEquals(interpretarConferencia({ conferido: true, divergente: false }), { tipo: "bate" });
  const dif = [{ tipo: "quantidade", sku: "A", app: 1, portal: 2 }];
  assertEquals(interpretarConferencia({ conferido: true, divergente: true, divergencia_id: 7, diferencas: dif }),
    { tipo: "divergente", divergenciaId: 7, diferencas: dif });
  assertEquals(interpretarConferencia({ conferido: false, motivo: "leitura_antiga" }), { tipo: "recusada", motivo: "leitura_antiga" });
});

Deno.test("interpretarConferencia: fora do contrato LANÇA — nunca vira 'bate'", () => {
  assertThrows(() => interpretarConferencia(null), Error, "sem resposta legível");
  assertThrows(() => interpretarConferencia({ divergente: false }), Error, "sem o campo 'conferido'");
  assertThrows(() => interpretarConferencia({ conferido: true }), Error, "sem o campo 'divergente'");
  assertThrows(() => interpretarConferencia({ conferido: true, divergente: true, divergencia_id: 7, diferencas: [] }), Error,
    "sem id ou sem diferenças");
  assertThrows(() => interpretarConferencia({ conferido: true, divergente: true, diferencas: [{ tipo: "x" }] }), Error,
    "sem id ou sem diferenças");
  assertThrows(() => interpretarConferencia({ conferido: false }), Error, "recusada sem motivo");
});

Deno.test("conferirPortal: erro do banco LANÇA com a mensagem; origem é sempre redisparo", async () => {
  const chamadas: Record<string, unknown>[] = [];
  const ok = { rpc: (_: string, a: Record<string, unknown>) => { chamadas.push(a); return Promise.resolve({ data: { conferido: true, divergente: false }, error: null }); } };
  assertEquals(await conferirPortal(ok, 5, { protocolo: "1" }, null), { tipo: "bate" });
  assertEquals([chamadas[0].p_pedido_id, chamadas[0].p_origem, chamadas[0].p_evidencia_id], [5, "redisparo", null]);
  const erro = { rpc: () => Promise.resolve({ data: null, error: { message: "boom", code: "22023" } }) };
  let msg = "";
  try { await conferirPortal(erro, 5, {}, null); } catch (e) { msg = (e as Error).message; }
  assertEquals(msg, "conferência do portal falhou: boom");
});

Deno.test("resumoDiferencas: rótulo humano, ausente como —, no máximo 4", () => {
  const d = [
    { tipo: "quantidade", sku: "A", app: 1, portal: 2 },
    { tipo: "sku_novo_no_portal", sku: "B", app: null, portal: 3 },
    { tipo: "condicao", sku: null, app: "70 - 7 DIAS", portal: "28 - 28 DIAS" },
    { tipo: "valor_total", sku: null, app: 10, portal: 11 },
    { tipo: "valor_item", sku: "A", app: 5, portal: 6 },
  ];
  assertEquals(resumoDiferencas(d),
    "quantidade A: app 1 → portal 2; SKU novo no portal B: app — → portal 3; condição de pagamento: app 70 - 7 DIAS → portal 28 - 28 DIAS; valor total: app 10 → portal 11; e mais 1");
  assertEquals(mensagemRecusa("xyz"), "A conferência com o portal recusou (xyz).");
});
