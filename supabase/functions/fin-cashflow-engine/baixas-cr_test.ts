// deno test supabase/functions/fin-cashflow-engine/baixas-cr_test.ts
import { carregarBaixasCr, parsearMapaBaixasCr } from "./baixas-cr.ts";
import { FalhaLeituraCritica } from "../_shared/leitura-critica.ts";

function assertEq(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEq"}: esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`);
  }
}
/** Casa a MARCA do ramo (classe + código), não "lançou algo". */
async function assertFalha(f: () => unknown, codigo: string) {
  try {
    await f();
  } catch (e) {
    if (!(e instanceof FalhaLeituraCritica)) throw new Error(`esperava FalhaLeituraCritica, veio ${e}`);
    if (e.codigo !== codigo) throw new Error(`esperava codigo ${codigo}, veio ${e.codigo}`);
    if (e.fonte !== "fin_titulo_baixas_cr_mapa") throw new Error(`fonte errada: ${e.fonte}`);
    return;
  }
  throw new Error(`não lançou (esperava ${codigo})`);
}

Deno.test("parsearMapaBaixasCr: pares viram as linhas que a view devolvia", () => {
  const r = parsearMapaBaixasCr({ data: [[101, "2026-09-30"], [9876543210, "2026-10-01"]], error: null });
  assertEq(r, [
    { omie_codigo_lancamento: 101, data_baixa_final: "2026-09-30" },
    { omie_codigo_lancamento: 9876543210, data_baixa_final: "2026-10-01" },
  ]);
});

Deno.test("parsearMapaBaixasCr: array vazio é fato (empresa sem baixa), não falha", () => {
  assertEq(parsearMapaBaixasCr({ data: [], error: null }), []);
});

Deno.test("parsearMapaBaixasCr: erro do banco (57014) LANÇA com o código real — nunca lista vazia", async () => {
  await assertFalha(() => parsearMapaBaixasCr({ data: null, error: { code: "57014", message: "canceling statement" } }), "57014");
});

Deno.test("parsearMapaBaixasCr: data null sem erro é MALFORMADA", async () => {
  await assertFalha(() => parsearMapaBaixasCr({ data: null, error: null }), "MALFORMADA");
});

Deno.test("parsearMapaBaixasCr: objeto no lugar do array é MALFORMADA", async () => {
  await assertFalha(() => parsearMapaBaixasCr({ data: { a: 1 }, error: null }), "MALFORMADA");
});

Deno.test("parsearMapaBaixasCr: par fora de forma é MALFORMADA", async () => {
  for (const par of [[1], [1, null], ["1", "2026-01-01"], [1.5, "2026-01-01"], [1, "01/01/2026"], null]) {
    await assertFalha(() => parsearMapaBaixasCr({ data: [par], error: null }), "MALFORMADA");
  }
});

Deno.test("carregarBaixasCr: chama a RPC literal com p_company", async () => {
  const chamadas: unknown[] = [];
  const cli = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      chamadas.push([fn, args]);
      return Promise.resolve({ data: [[7, "2026-10-02"]], error: null });
    },
  };
  const r = await carregarBaixasCr(cli, "colacor");
  assertEq(chamadas, [["fin_titulo_baixas_cr_mapa", { p_company: "colacor" }]]);
  assertEq(r, [{ omie_codigo_lancamento: 7, data_baixa_final: "2026-10-02" }]);
});

Deno.test("carregarBaixasCr: rejeição do transporte vira REJEITADA (sem texto cru na mensagem)", async () => {
  const cli = { rpc: () => Promise.reject(new Error("fetch failed 12345678901")) };
  await assertFalha(() => carregarBaixasCr(cli, "colacor"), "REJEITADA");
  try { await carregarBaixasCr(cli, "colacor"); } catch (e) {
    if (String((e as Error).message).includes("12345678901")) throw new Error("texto cru vazou na mensagem");
  }
});
