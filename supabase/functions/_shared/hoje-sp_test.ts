// Testa o CÓDIGO REAL de hoje-sp.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/hoje-sp_test.ts
//
// O relógio é INJETADO: teste de fuso com o relógio de parede passa ou falha conforme a hora em que
// roda. Cada borda vem em par de 1 s, e o controle POSITIVO (o dia muda à meia-noite de SP) é o que
// impede os asserts de "não mudou às 21h" de passarem por vacuidade.
import { diaSP, hojeSP, somarDias } from "./hoje-sp.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg ?? `esperava ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}

function assertLancaRange(fn: () => unknown, marca: string) {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof RangeError)) throw new Error(`esperava RangeError, veio ${String(e)}`);
    if (!e.message.includes(marca)) throw new Error(`RangeError sem a marca "${marca}": ${e.message}`);
    return;
  }
  throw new Error(`esperava RangeError "${marca}", não lançou`);
}

// O dia UTC escrito à mão (sem a forma que o gate reprova): é o lado ERRADO que o par compara.
const diaUtc = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

Deno.test("20:59:59 BRT de D: o dia é D (UTC e SP ainda coincidem)", () => {
  const t = new Date("2026-09-30T23:59:59Z");
  assertEquals(hojeSP(t), "2026-09-30");
  assertEquals(diaUtc(t), "2026-09-30");
});

Deno.test("21:00:00 BRT de D: SP continua em D — e o UTC já virou (o defeito que este helper conserta)", () => {
  const t = new Date("2026-10-01T00:00:00Z");
  assertEquals(hojeSP(t), "2026-09-30");
  // controle: o instante está mesmo dentro da janela (sem isto, o assert acima passaria fora dela)
  assertEquals(diaUtc(t), "2026-10-01");
});

Deno.test("23:59:59 BRT de D: SP ainda em D", () => {
  assertEquals(hojeSP(new Date("2026-10-01T02:59:59Z")), "2026-09-30");
});

Deno.test("CONTROLE POSITIVO: 00:00:00 BRT de D+1 — o dia de SP vira exatamente aqui", () => {
  assertEquals(hojeSP(new Date("2026-10-01T03:00:00Z")), "2026-10-01");
});

Deno.test("virada de ano à noite: 31/12 23:30 BRT ainda é 31/12", () => {
  assertEquals(hojeSP(new Date("2027-01-01T02:30:00Z")), "2026-12-31");
});

Deno.test("fuso NOMEADO, não offset fixo: no horário de verão de 2018 (UTC−2) a meia-noite andou", () => {
  // 01/12/2018 02:30Z = 00:30 em SP sob o horário de verão (UTC−2). Com UTC−3 fixo daria 30/11.
  assertEquals(diaSP(new Date("2018-12-01T02:30:00Z")), "2018-12-01");
});

Deno.test("instante inválido lança — ausente não vira hoje", () => {
  assertLancaRange(() => diaSP(new Date("não é data")), "instante inválido");
});

Deno.test("somarDias: aritmética de calendário nas bordas", () => {
  assertEquals(somarDias("2026-02-28", 1), "2026-03-01");
  assertEquals(somarDias("2024-02-28", 1), "2024-02-29");
  assertEquals(somarDias("2026-01-01", -1), "2025-12-31");
  assertEquals(somarDias("2026-09-30", 0), "2026-09-30");
  assertEquals(somarDias("2026-10-31", 31), "2026-12-01");
});

Deno.test("somarDias: data malformada ou deslocamento não inteiro lança", () => {
  assertLancaRange(() => somarDias("30/09/2026", 1), "inválido");
  assertLancaRange(() => somarDias("2026-09-30", 1.5), "inválido");
});
