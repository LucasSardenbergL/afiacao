import { dominaOuIguala, itensDaRevisao, parcelaEfetiva, registrarRevisao, type RevisaoCredito } from "./revisao-credito.ts";
import type { ClienteGate } from "./gate-credito.ts";

// Roda o CÓDIGO REAL de revisao-credito.ts. Asserções locais: `test:edges` roda com `--no-remote`.
function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}
function capturaErro(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error) return e;
    throw new Error(`lançou não-Error: ${String(e)}`);
  }
  throw new Error("esperava lançar e não lançou");
}

const REV: RevisaoCredito = {
  revisao: "r1", seq: 1, reusada: false, codigo_parcela: "A28", parcela_origem: "informada",
  prazo_dias: 28, prazo_fonte: "catalogo", valor_brl: 21,
  itens: [{ codigo_produto: 101, quantidade: 2, valor_unitario: 10.5 }],
};

function cliente(resposta: { data: unknown; error: { message: string } | null } | "lanca"): { c: ClienteGate; args: Record<string, unknown>[] } {
  const args: Record<string, unknown>[] = [];
  const c: ClienteGate = {
    rpc: (_n, a) => {
      args.push(a);
      if (resposta === "lanca") return Promise.reject(new Error("rede caiu"));
      return Promise.resolve(resposta);
    },
    from: () => ({ insert: () => Promise.resolve({ error: null }) }),
  };
  return { c, args };
}
const BASE = { salesOrderId: "so1", company: "oben", contexto: "criacao" as const, codigoCliente: 7, userId: null };

Deno.test("parcelaEfetiva: informada > herdada do PV > 999 default", () => {
  assertEquals(parcelaEfetiva(" A28 ", "A90"), { codigo: "A28", origem: "informada" });
  assertEquals(parcelaEfetiva("", "A90"), { codigo: "A90", origem: "herdada_omie" });
  assertEquals(parcelaEfetiva(undefined, null), { codigo: "999", origem: "default_999" });
  assertEquals(parcelaEfetiva("000"), { codigo: "000", origem: "informada" }); // código textual preservado
});

Deno.test("itensDaRevisao: envio usa quantidade/preço DA revisão, cosmético do payload", () => {
  const out = itensDaRevisao([{ omie_codigo_produto: "101", quantidade: 2, valor_unitario: 10.5, descricao: "X" }], REV);
  assertEquals(out, [{ omie_codigo_produto: 101, quantidade: 2, valor_unitario: 10.5, descricao: "X" }]);
});
Deno.test("itensDaRevisao: tamanho divergente recusa o envio", () => {
  const e = capturaErro(() => itensDaRevisao([], REV));
  assertEquals(e.message.includes("tem 1 itens e o envio 0"), true);
});
Deno.test("itensDaRevisao: código divergente item a item recusa o envio", () => {
  const e = capturaErro(() => itensDaRevisao([{ omie_codigo_produto: 999, quantidade: 2, valor_unitario: 10.5 }], REV));
  assertEquals(e.message.includes("item 0 é 101 e o envio 999"), true);
});
Deno.test("itensDaRevisao: sem revisão (PR 3 não bloqueia) devolve o payload", () => {
  const items = [{ omie_codigo_produto: 1, quantidade: 1, valor_unitario: 1 }];
  assertEquals(itensDaRevisao(items, null), items);
});

Deno.test("registrarRevisao: manda a projeção money-path e a parcela efetiva", async () => {
  const { c, args } = cliente({ data: REV, error: null });
  const r = await registrarRevisao(c, { ...BASE, parcela: { codigo: "999", origem: "default_999" },
    items: [{ omie_codigo_produto: 101, quantidade: 2, valor_unitario: 10.5 }] });
  assertEquals(r?.revisao, "r1");
  assertEquals(args[0].p_codigo_parcela, "999");
  assertEquals(args[0].p_parcela_origem, "default_999");
  assertEquals(args[0].p_omie_codigo_cliente, 7);
  assertEquals(args[0].p_itens, [{ codigo_produto: 101, quantidade: 2, valor_unitario: 10.5 }]);
});
Deno.test("registrarRevisao: erro da RPC → null (não segura o envio no PR 3)", async () => {
  const { c } = cliente({ data: null, error: { message: "função não existe" } });
  assertEquals(await registrarRevisao(c, { ...BASE, parcela: { codigo: "A28", origem: "informada" }, items: [] }), null);
});
Deno.test("registrarRevisao: RPC lança → null", async () => {
  const { c } = cliente("lanca");
  assertEquals(await registrarRevisao(c, { ...BASE, parcela: { codigo: "A28", origem: "informada" }, items: [] }), null);
});
Deno.test("registrarRevisao: resposta sem 'revisao' → null", async () => {
  const { c } = cliente({ data: { seq: 1 }, error: null });
  assertEquals(await registrarRevisao(c, { ...BASE, parcela: { codigo: "A28", origem: "informada" }, items: [] }), null);
});

Deno.test("dominaOuIguala: igual domina; mais curto domina; 75 não domina 30/60/90", () => {
  assertEquals(dominaOuIguala([28], [28]), true);
  assertEquals(dominaOuIguala([28], [90]), true);
  assertEquals(dominaOuIguala([0], [30, 60, 90]), true);
  assertEquals(dominaOuIguala([75], [30, 60, 90]), false);
  assertEquals(dominaOuIguala([90], [28]), false);
  assertEquals(dominaOuIguala([], [28]), false);
});
