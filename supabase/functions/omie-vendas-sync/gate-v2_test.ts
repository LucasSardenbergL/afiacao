// Roda o CÓDIGO REAL de gate-v2.ts (crédito-IA 6b): contrato de cada resultado da RPC
// credito_gate_v2_efetivo. Paridade com o flag desligado = `segue` sem nenhuma outra chamada.
import {
  type ClienteGateV2,
  gateV2Efetivo,
  MENSAGEM_V2_AMARELO,
  MENSAGEM_V2_INDISPONIVEL,
  MENSAGEM_V2_REVALIDAR,
  MENSAGEM_V2_VERMELHO,
} from "./gate-v2.ts";

// Asserções locais em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}
function assertComeca(s: string, prefixo: string) {
  if (!s.startsWith(prefixo)) throw new Error(`esperava começar com ${JSON.stringify(prefixo)}: ${JSON.stringify(s)}`);
}

function cliente(resposta: { data: unknown; error: { message: string } | null } | "lanca") {
  const chamadas: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const c: ClienteGateV2 = {
    rpc(nome, args) {
      chamadas.push({ nome, args });
      if (resposta === "lanca") return Promise.reject(new Error("connection reset"));
      return Promise.resolve(resposta);
    },
  };
  return { c, chamadas };
}

const ARGS = { salesOrderId: "so-1", company: "oben", revisao: "rv-1", contexto: "criacao" as const };

Deno.test("desligado → segue, com UMA chamada e os argumentos exatos (paridade)", async () => {
  const { c, chamadas } = cliente({ data: { resultado: "desligado", ligado: false, company: "oben" }, error: null });
  const d = await gateV2Efetivo(c, ARGS);
  assertEquals(d, { segue: true, resultado: "desligado" });
  assertEquals(chamadas, [{
    nome: "credito_gate_v2_efetivo",
    args: { p_sales_order_id: "so-1", p_company: "oben", p_revisao: "rv-1" },
  }]);
});

Deno.test("revisão null vai como null (a RPC decide; desligado segue)", async () => {
  const { c, chamadas } = cliente({ data: { resultado: "desligado", ligado: false }, error: null });
  const d = await gateV2Efetivo(c, { ...ARGS, revisao: null });
  assertEquals(d.segue, true);
  assertEquals(chamadas[0].args.p_revisao, null);
});

Deno.test("desligado SEM ligado:false é resposta sem forma → segura (nunca infere o flag)", async () => {
  const { c } = cliente({ data: { resultado: "desligado" }, error: null });
  const d = await gateV2Efetivo(c, ARGS);
  assertEquals(d.segue, false);
  if (!d.segue) assertComeca(d.mensagem, MENSAGEM_V2_INDISPONIVEL);
});

Deno.test("avaliado verde → segue", async () => {
  const { c } = cliente({ data: { resultado: "avaliado", ligado: true, faixa: "verde" }, error: null });
  assertEquals(await gateV2Efetivo(c, ARGS), { segue: true, resultado: "verde" });
});

Deno.test("avaliado amarelo → segura com a solicitação na mensagem", async () => {
  const { c } = cliente({ data: { resultado: "avaliado", ligado: true, faixa: "amarelo", solicitacao_id: "sol-9" }, error: null });
  const d = await gateV2Efetivo(c, ARGS);
  assertEquals(d.segue, false);
  if (!d.segue) {
    assertEquals(d.resultado, "amarelo");
    assertEquals(d.mensagem, `${MENSAGEM_V2_AMARELO} · solicitação sol-9`);
  }
});

Deno.test("avaliado vermelho → recusa", async () => {
  const { c } = cliente({ data: { resultado: "avaliado", ligado: true, faixa: "vermelho", motivo: "estoura_limite" }, error: null });
  const d = await gateV2Efetivo(c, ARGS);
  assertEquals(d, { segue: false, resultado: "vermelho", mensagem: MENSAGEM_V2_VERMELHO });
});

Deno.test("avaliado sem faixa conhecida → sem forma, segura", async () => {
  const { c } = cliente({ data: { resultado: "avaliado", ligado: true, faixa: "azul" }, error: null });
  const d = await gateV2Efetivo(c, ARGS);
  assertEquals(d.segue, false);
  if (!d.segue) assertEquals(d.resultado, "indisponivel");
});

for (const r of ["pedido_inexistente", "conta_divergente", "revisao_inexistente", "revisao_superada"]) {
  Deno.test(`${r} → segura para revalidar (nunca segue)`, async () => {
    const { c } = cliente({ data: { resultado: r, ligado: r === "pedido_inexistente" ? null : true }, error: null });
    const d = await gateV2Efetivo(c, ARGS);
    assertEquals(d, { segue: false, resultado: r, mensagem: `${MENSAGEM_V2_REVALIDAR} (${r})` });
  });
}

Deno.test("erro da RPC (ex. 22023) → indisponível, segura", async () => {
  const { c } = cliente({ data: null, error: { message: "pedido e empresa são obrigatórios" } });
  const d = await gateV2Efetivo(c, ARGS);
  assertEquals(d.segue, false);
  if (!d.segue) {
    assertEquals(d.resultado, "indisponivel");
    assertComeca(d.mensagem, MENSAGEM_V2_INDISPONIVEL);
  }
});

Deno.test("transporte lança → indisponível, segura", async () => {
  const { c } = cliente("lanca");
  const d = await gateV2Efetivo(c, ARGS);
  assertEquals(d.segue, false);
  if (!d.segue) assertEquals(d.resultado, "indisponivel");
});

Deno.test("data nula / array / string → sem forma, segura", async () => {
  for (const data of [null, [], "desligado", 0]) {
    const { c } = cliente({ data, error: null });
    const d = await gateV2Efetivo(c, ARGS);
    assertEquals(d.segue, false);
  }
});
