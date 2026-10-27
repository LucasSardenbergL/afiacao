// deno test supabase/functions/fin-cashflow-engine/saldo-contas_test.ts
import { classificarSaldoConta, saldoInicialDasContas } from "./saldo-contas.ts";

const HOJE = "2026-10-26";

function assertEq(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEq"}: esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`);
  }
}
/** Casa a MARCA do ramo (trecho exclusivo da mensagem), não "lançou algo". */
function assertLanca(f: () => unknown, marca: string) {
  try {
    f();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes(marca)) throw new Error(`esperava erro com "${marca}", veio "${msg}"`);
    return;
  }
  throw new Error(`esperava lançar com "${marca}", não lançou`);
}

Deno.test("todas frescas: soma, sem motivo", () => {
  assertEq(
    saldoInicialDasContas([
      { saldo_atual: 100, saldo_data: HOJE },
      { saldo_atual: "50.5", saldo_data: "2026-10-25" },
      { saldo_atual: -10, saldo_data: HOJE },
    ], HOJE),
    { saldo: 140.5, motivo: null },
  );
});

Deno.test("conta sem saldo do extrato (saldo_data NULL, saldo_atual = DEFAULT 0) LANÇA — não soma zero", () => {
  assertLanca(
    () => saldoInicialDasContas([{ saldo_atual: 100, saldo_data: HOJE }, { saldo_atual: 0, saldo_data: null }], HOJE),
    "1 de 2 conta(s) ativa(s) sem saldo do extrato",
  );
});

Deno.test("saldo_atual NULL LANÇA (o Number(c.saldo_atual ?? 0) o fazia R$ 0)", () => {
  assertLanca(
    () => saldoInicialDasContas([{ saldo_atual: null, saldo_data: HOJE }], HOJE),
    "1 de 1 conta(s) ativa(s) sem saldo do extrato",
  );
});

Deno.test("lista vazia LANÇA", () => {
  assertLanca(() => saldoInicialDasContas([], HOJE), "nenhuma conta ativa");
});

Deno.test("conta velha entra DATADA, com motivo que cita a data mais antiga", () => {
  const r = saldoInicialDasContas([
    { saldo_atual: 100, saldo_data: HOJE },
    { saldo_atual: 900, saldo_data: "2026-10-20" },
    { saldo_atual: 5, saldo_data: "2026-10-23" },
  ], HOJE);
  assertEq(r.saldo, 1005, "saldo");
  if (!r.motivo?.includes("Saldo inicial PARCIAL: 2 de 3 conta(s) corrente(s) com saldo do extrato de 2026-10-20")) {
    throw new Error(`motivo inesperado: ${r.motivo}`);
  }
});

Deno.test("classificação: ontem fresco, anteontem velho, futuro desconhecido", () => {
  assertEq(classificarSaldoConta({ saldo_atual: 1, saldo_data: "2026-10-25" }, HOJE), "fresca");
  assertEq(classificarSaldoConta({ saldo_atual: 1, saldo_data: "2026-10-24" }, HOJE), "velha");
  assertEq(classificarSaldoConta({ saldo_atual: 1, saldo_data: "2026-10-27" }, HOJE), "desconhecida");
});
