// deno test supabase/functions/fin-cashflow-engine/saldo-contas_test.ts
import {
  classificarSaldoConta,
  HORAS_TOLERANCIA_SYNC_BASE,
  marcarAlertasDoSaldoDatado,
  referenciaFrescorSaldo,
  SALDO_IDADE_MAX_PARCIAL_DIAS,
  saldoInicialDasContas,
  TIPOS_ALERTA_DO_SALDO,
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
    { saldo: 140.5, motivo: null, parcial: null },
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
  assertEq(saldoInicialDasContas([{ saldo_atual: 10, saldo_data: "2026-10-25" }], madrugada), { saldo: 10, motivo: null, parcial: null });
});

Deno.test("classificação: futuro é desconhecido", () => {
  assertEq(classificarSaldoConta({ saldo_atual: 1, saldo_data: HOJE }, REF), "fresca");
  assertEq(classificarSaldoConta({ saldo_atual: 1, saldo_data: "2026-10-27" }, REF), "desconhecida");
});

// fin_alertas do mesmo run carregam o saldo datado (plano v3, item 2 — lacuna dos alertas).
const SEIS = ["caixa_negativo", "ncg_deficit", "cobertura_baixa", "inadimplencia_alta", "concentracao_top1", "saida_spike"]
  .map((tipo) => ({ tipo, mensagem: `m-${tipo}`, contexto: { k: tipo } as Record<string, unknown>, valor: 1 }));

Deno.test("alertas: saldo datado marca SÓ os 3 que partem do saldo (mensagem curta + motivo no contexto)", () => {
  const r = saldoInicialDasContas([
    { saldo_atual: 100, saldo_data: HOJE },
    { saldo_atual: 900, saldo_data: "2026-10-20" },
    { saldo_atual: 5, saldo_data: "2026-10-25" },
  ], REF);
  assertEq(r.parcial?.velhas, 2, "velhas");
  assertEq(r.parcial?.total, 3, "total");
  assertEq(r.parcial?.maisAntiga, "2026-10-20", "maisAntiga");
  assertEq(r.parcial?.motivo, r.motivo, "o motivo do parcial é o mesmo do snapshot");
  const marcados = marcarAlertasDoSaldoDatado(SEIS, r.parcial);
  assertEq(TIPOS_ALERTA_DO_SALDO, ["caixa_negativo", "ncg_deficit", "cobertura_baixa"], "tipos do saldo");
  for (const a of marcados) {
    const doSaldo = TIPOS_ALERTA_DO_SALDO.includes(a.tipo);
    const esperada = doSaldo ? `m-${a.tipo} — saldo inicial PARCIAL: 2 de 3 conta(s) com extrato de 20/10/2026` : `m-${a.tipo}`;
    assertEq(a.mensagem, esperada, `mensagem de ${a.tipo}`);
    assertEq(a.contexto, doSaldo ? { k: a.tipo, saldo_cc_parcial: r.motivo } : { k: a.tipo }, `contexto de ${a.tipo}`);
    assertEq(a.valor, 1, `valor de ${a.tipo} intocado`);
  }
  // não muta a entrada (o mesmo array vira resposta e persistência)
  assertEq(SEIS[0].mensagem, "m-caixa_negativo", "entrada intacta");
});

Deno.test("alertas: saldo fresco não marca nada — a transição datado → fresco limpa a marca", () => {
  const r = saldoInicialDasContas([{ saldo_atual: 100, saldo_data: HOJE }], REF);
  assertEq(r.parcial, null, "parcial");
  assertEq(r.motivo, null, "motivo");
  const limpos = marcarAlertasDoSaldoDatado(SEIS, r.parcial);
  assertEq(limpos, SEIS, "os 6 alertas intactos");
});
