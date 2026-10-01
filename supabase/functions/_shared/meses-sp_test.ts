// Testa o CÓDIGO REAL de meses-sp.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/meses-sp_test.ts
import { somarMeses } from "./meses-sp.ts";

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

const diaUtc = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

Deno.test("somarMeses: a semântica de setMonth, transbordo incluído (é a régua das janelas que substitui)", () => {
  assertEquals(somarMeses("2026-09-30", -6), "2026-03-30");
  assertEquals(somarMeses("2026-08-31", -6), "2026-03-03"); // 31/02 não existe: transborda, como setMonth
  assertEquals(somarMeses("2026-01-15", -3), "2025-10-15");
  assertEquals(somarMeses("2024-02-29", 12), "2025-03-01");
  // controle: é exatamente o que setUTCMonth faz sobre a mesma data
  const d = new Date(Date.UTC(2026, 7, 31));
  d.setUTCMonth(d.getUTCMonth() - 6);
  assertEquals(somarMeses("2026-08-31", -6), diaUtc(d));
});

Deno.test("somarMeses: data malformada ou deslocamento não inteiro lança", () => {
  assertLancaRange(() => somarMeses("2026/08/31", -6), "inválido");
  assertLancaRange(() => somarMeses("2026-08-31", 0.5), "inválido");
});
