// deno test supabase/functions/fin-cashflow-engine/saldo-contas_test.ts
import {
  classificarSaldoConta,
  HORAS_TOLERANCIA_SYNC_BASE,
  referenciaFrescorSaldo,
  SALDO_IDADE_MAX_PARCIAL_DIAS,
  saldoInicialDasContas,
} from "./saldo-contas.ts";

const HOJE = "2026-10-26";
// 07h SP (a hora do fin-cashflow-snapshot-diario): só o saldo de HOJE é fresco.
const REF = referenciaFrescorSaldo(new Date("2026-10-26T10:00:00Z"));

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
  assertEq(REF, { hoje: HOJE, minimo: HOJE }, "referência às 07h SP");
  assertEq(
    saldoInicialDasContas([
      { saldo_atual: 100, saldo_data: HOJE },
      { saldo_atual: "50.5", saldo_data: HOJE },
      { saldo_atual: -10, saldo_data: HOJE },
    ], REF),
    { saldo: 140.5, motivo: null },
  );
});

Deno.test("conta sem saldo do extrato (saldo_data NULL, saldo_atual = DEFAULT 0) LANÇA — não soma zero", () => {
  assertLanca(
    () => saldoInicialDasContas([{ saldo_atual: 100, saldo_data: HOJE }, { saldo_atual: 0, saldo_data: null }], REF),
    "1 de 2 conta(s) ativa(s) sem saldo do extrato",
  );
});

Deno.test("saldo_atual NULL LANÇA (o Number(c.saldo_atual ?? 0) o fazia R$ 0)", () => {
  assertLanca(
    () => saldoInicialDasContas([{ saldo_atual: null, saldo_data: HOJE }], REF),
    "1 de 1 conta(s) ativa(s) sem saldo do extrato",
  );
});

Deno.test("lista vazia LANÇA", () => {
  assertLanca(() => saldoInicialDasContas([], REF), "nenhuma conta ativa");
});

Deno.test("conta velha entra DATADA, com motivo que cita a data mais antiga", () => {
  const r = saldoInicialDasContas([
    { saldo_atual: 100, saldo_data: HOJE },
    { saldo_atual: 900, saldo_data: "2026-10-20" },
    { saldo_atual: 5, saldo_data: "2026-10-25" },
  ], REF);
  assertEq(r.saldo, 1005, "saldo");
  if (!r.motivo?.includes("Saldo inicial PARCIAL: 2 de 3 conta(s) corrente(s) com saldo do extrato de 2026-10-20")) {
    throw new Error(`motivo inesperado: ${r.motivo}`);
  }
});

Deno.test("UM sync perdido às 03h já marca a conta às 07h (o 'hoje ou ontem' deixava passar)", () => {
  const r = saldoInicialDasContas([{ saldo_atual: 100, saldo_data: HOJE }, { saldo_atual: 50, saldo_data: "2026-10-25" }], REF);
  assertEq(r.saldo, 150, "saldo");
  if (!r.motivo?.includes("anterior a 2026-10-26")) throw new Error(`motivo inesperado: ${r.motivo}`);
  // O motivo não afirma que a NCG usa o saldo (ela é ACO − PCO).
  if (r.motivo.includes("NCG")) throw new Error(`motivo cita a NCG: ${r.motivo}`);
});

Deno.test("conta velha além do teto LANÇA — parada há semanas não é 'datada'", () => {
  assertEq(SALDO_IDADE_MAX_PARCIAL_DIAS, 7, "teto");
  saldoInicialDasContas([{ saldo_atual: 1, saldo_data: "2026-10-19" }], REF); // 7 dias: ainda entra
  assertLanca(
    () => saldoInicialDasContas([{ saldo_atual: 1, saldo_data: HOJE }, { saldo_atual: 1, saldo_data: "2026-10-18" }], REF),
    "conta(s) com saldo do extrato de 2026-10-18 (8 dias, teto 7)",
  );
});

Deno.test("madrugada (antes das 04h SP): o saldo de ontem ainda é o último possível", () => {
  assertEq(HORAS_TOLERANCIA_SYNC_BASE, 4, "tolerância");
  const madrugada = referenciaFrescorSaldo(new Date("2026-10-26T06:59:00Z")); // 03:59 SP
  assertEq(madrugada, { hoje: HOJE, minimo: "2026-10-25" });
  assertEq(saldoInicialDasContas([{ saldo_atual: 10, saldo_data: "2026-10-25" }], madrugada), { saldo: 10, motivo: null });
});

Deno.test("classificação: futuro é desconhecido", () => {
  assertEq(classificarSaldoConta({ saldo_atual: 1, saldo_data: HOJE }, REF), "fresca");
  assertEq(classificarSaldoConta({ saldo_atual: 1, saldo_data: "2026-10-27" }, REF), "desconhecida");
});
