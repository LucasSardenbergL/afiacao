// Roda o CÓDIGO REAL de gate-credito.ts (piso do grupo, fail-closed, gatilho de edição).
import { type ClienteGate, edicaoExigeGate, gateCredito, type GateCreditoResultado } from "./gate-credito.ts";

// Asserções locais em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const BLOQUEADO: GateCreditoResultado = {
  bloqueado: true,
  vencido: 500,
  titulos: 1,
  vencimento_mais_antigo: "2026-09-01",
  excecao_id: null,
  pares: [{ company: "colacor_sc", codigo: 202, vencido: 500, titulos: 1, vencimento_mais_antigo: "2026-09-01" }],
  grupo_resolvido: true,
  motivo: "vencido_60d_sem_excecao",
};

function cliente(opts: {
  rpc?: { data: unknown; error: { message: string } | null } | "lanca";
  logFalha?: boolean;
}) {
  const chamadas: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const c: ClienteGate = {
    rpc(nome, args) {
      chamadas.push({ nome, args });
      if (opts.rpc === "lanca") return Promise.reject(new Error("connection reset"));
      return Promise.resolve(opts.rpc ?? { data: null, error: null });
    },
    from(_tabela) {
      return {
        insert(linha) {
          logs.push(linha);
          return Promise.resolve({ error: opts.logFalha ? { message: "log fora" } : null });
        },
      };
    },
  };
  return { c, chamadas, logs };
}

const ARGS = {
  company: "oben" as const,
  codigo: 101,
  salesOrderId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  userId: "u1",
  contexto: "criacao" as const,
};

Deno.test("T1 gate bloqueado → permitido:false motivo credito + log 'bloqueado' com os pares", async () => {
  const { c, logs } = cliente({ rpc: { data: BLOQUEADO, error: null } });
  const r = await gateCredito(c, ARGS);
  assertEquals(r.permitido, false);
  assertEquals(r.permitido === false && r.motivo, "credito");
  assertEquals(logs[0].acao, "bloqueado");
  assertEquals(logs[0].detalhe, "pares: colacor_sc/202=500");
});

Deno.test("T2 RPC lança → SEGURA (credito_indisponivel), nunca libera, e tenta logar", async () => {
  const { c, logs } = cliente({ rpc: "lanca" });
  const r = await gateCredito(c, ARGS);
  assertEquals(r.permitido, false);
  assertEquals(r.permitido === false && r.motivo, "credito_indisponivel");
  assertEquals(logs[0].acao, "gate_indisponivel");
});

Deno.test("T2b RPC devolve error → SEGURA", async () => {
  const { c } = cliente({ rpc: { data: null, error: { message: "42883 function does not exist" } } });
  const r = await gateCredito(c, ARGS);
  assertEquals(r.permitido === false && r.motivo, "credito_indisponivel");
});

Deno.test("T2c RPC devolve payload sem 'bloqueado' → SEGURA (não lê undefined como liberado)", async () => {
  const { c } = cliente({ rpc: { data: { motivo: "x" }, error: null } });
  const r = await gateCredito(c, ARGS);
  assertEquals(r.permitido === false && r.motivo, "credito_indisponivel");
});

Deno.test("T3 RPC do grupo chamada SÓ com o par comprovado (sem UUID do pedido)", async () => {
  const { c, chamadas } = cliente({ rpc: { data: { ...BLOQUEADO, bloqueado: false, pares: [] }, error: null } });
  await gateCredito(c, ARGS);
  assertEquals(chamadas[0].nome, "venda_gate_credito_grupo");
  assertEquals(chamadas[0].args, {
    p_sales_order_id: ARGS.salesOrderId,
    p_company: "oben",
    p_codigo: 101,
  });
});

Deno.test("T4 bloqueio cujo log falha → lança 'sem log durável' (bloqueio nunca sem rastro)", async () => {
  const { c } = cliente({ rpc: { data: BLOQUEADO, error: null }, logFalha: true });
  let msg = "";
  try {
    await gateCredito(c, ARGS);
  } catch (e) {
    msg = (e as Error).message;
  }
  assertEquals(msg.includes("Bloqueio de crédito sem log durável"), true);
});

Deno.test("T5 RPC lança E log falha → ainda SEGURA sem lançar", async () => {
  const { c } = cliente({ rpc: "lanca", logFalha: true });
  const r = await gateCredito(c, ARGS);
  assertEquals(r.permitido === false && r.motivo, "credito_indisponivel");
});

Deno.test("T5b edição bloqueada grava 'bloqueado_edicao'", async () => {
  const { c, logs } = cliente({ rpc: { data: BLOQUEADO, error: null } });
  await gateCredito(c, { ...ARGS, contexto: "edicao" });
  assertEquals(logs[0].acao, "bloqueado_edicao");
});

Deno.test("edicaoExigeGate: troca só de prazo, mesmo total → exige gate", () => {
  assertEquals(edicaoExigeGate({ subtotalNovo: 100, subtotalOmie: 100, parcelaNova: "028", parcelaOmie: "090" }), true);
});
Deno.test("edicaoExigeGate: mesmo total e mesma parcela → não exige", () => {
  assertEquals(edicaoExigeGate({ subtotalNovo: 100, subtotalOmie: 100, parcelaNova: "028", parcelaOmie: "028" }), false);
});
Deno.test("edicaoExigeGate: total sobe, mesma parcela → exige", () => {
  assertEquals(edicaoExigeGate({ subtotalNovo: 101, subtotalOmie: 100, parcelaNova: "028", parcelaOmie: "028" }), true);
});
Deno.test("edicaoExigeGate: undefined vs '999' é a mesma parcela", () => {
  assertEquals(edicaoExigeGate({ subtotalNovo: 90, subtotalOmie: 100, parcelaNova: undefined, parcelaOmie: "999" }), false);
});
Deno.test("edicaoExigeGate: parcela some (vira 999 no envio) com PV em 028 → exige", () => {
  assertEquals(edicaoExigeGate({ subtotalNovo: 90, subtotalOmie: 100, parcelaNova: "", parcelaOmie: "028" }), true);
});
