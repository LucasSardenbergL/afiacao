// snapshot-relogio_test.ts — o `generated_at` do /keys-snapshot não reserva o futuro
// (scanner Lovable, lote 6; achado do Codex no desenho). Roda no CI via `bun run test:edges`
// (deno test --no-remote) — SEM import remoto.
//
// O que está em jogo: o banco ordena os snapshots de chaves por `generated_at` e pula como "fora
// de ordem" o que vier com valor menor ou igual ao último aplicado. Um valor no futuro distante
// congelava a sincronização das retiradas do catálogo.
import { TOLERANCIA_FUTURO_MS, validarGeneratedAt } from "./snapshot-relogio.ts";

function assertEq(atual: unknown, esperado: unknown, msg: string) {
  if (!Object.is(atual, esperado)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(atual)}`);
  }
}

/** Relógio do servidor fixo: 2026-11-17T03:08:05Z (o recebimento do snapshot mais recente da PROD). */
const AGORA = Date.parse("2026-11-17T03:08:05Z");
const iso = (ms: number) => new Date(ms).toISOString();

function recusaCom(valor: unknown, trecho: string, msg: string) {
  const v = validarGeneratedAt(valor, AGORA);
  if (v.ok) throw new Error(`${msg}: passou, e devia ser recusado (${JSON.stringify(valor)})`);
  if (!v.erro.includes(trecho)) throw new Error(`${msg}: recusou pelo motivo errado: ${v.erro}`);
}

Deno.test("formato real do conector (RFC 3339, ~4 min atrás) passa", () => {
  assertEq(validarGeneratedAt("2026-11-17T03:03:41Z", AGORA).ok, true, "Z");
  assertEq(validarGeneratedAt("2026-11-17T00:03:41-03:00", AGORA).ok, true, "offset -03:00 (mesmo instante)");
  assertEq(validarGeneratedAt("2026-11-17T03:03:41.123456Z", AGORA).ok, true, "fração de segundo");
  assertEq(validarGeneratedAt("2026-11-17 03:03:41+00:00", AGORA).ok, true, "espaço no lugar do T");
});

Deno.test("passado distante passa: quem decide 'fora de ordem' é o banco", () => {
  assertEq(validarGeneratedAt("2020-01-01T00:00:00Z", AGORA).ok, true, "2020");
});

Deno.test("futuro distante é recusado, com o relógio do servidor na mensagem", () => {
  recusaCom("2099-01-01T00:00:00Z", "in the future", "2099");
  recusaCom(iso(AGORA + 60 * 60_000), "in the future", "1 hora à frente");
  const v = validarGeneratedAt("2099-01-01T00:00:00Z", AGORA);
  if (v.ok || !v.erro.includes("2026-11-17T03:08:05.000Z")) {
    throw new Error("a recusa não informa o relógio do servidor: " + JSON.stringify(v));
  }
});

Deno.test("a tolerância é de 10 minutos, e a fronteira é inclusiva", () => {
  assertEq(TOLERANCIA_FUTURO_MS, 600_000, "tolerância");
  assertEq(validarGeneratedAt(iso(AGORA + 5 * 60_000), AGORA).ok, true, "5 min à frente passa");
  assertEq(validarGeneratedAt(iso(AGORA + TOLERANCIA_FUTURO_MS), AGORA).ok, true, "exatamente na tolerância passa");
  recusaCom(iso(AGORA + TOLERANCIA_FUTURO_MS + 1), "in the future", "1 ms além da tolerância");
});

Deno.test("o fuso do texto é respeitado: -03:00 no futuro é futuro", () => {
  // 03:30 no fuso -03:00 = 06:30Z, mais de 3 horas à frente das 03:08Z do servidor.
  recusaCom("2026-11-17T03:30:00-03:00", "in the future", "offset que joga o instante para frente");
  // O mesmo relógio de parede com +03:00 é 00:30Z, no passado.
  assertEq(validarGeneratedAt("2026-11-17T03:30:00+03:00", AGORA).ok, true, "offset que joga para trás");
});

Deno.test("o que não é RFC 3339 com fuso é recusado — nada é adivinhado", () => {
  for (const ruim of [
    "2026-11-17T03:03:41", // sem fuso: ambíguo
    "2026-11-17",
    "2099",
    "ontem",
    "Tue, 17 Nov 2026 03:03:41 GMT",
    "2026-11-17T03:03:41Z; DROP",
    " 2026-11-17T03:03:41Z",
    "",
    1_794_625_421_000,
    true,
    null,
    undefined,
    { ts: "2026-11-17T03:03:41Z" },
    ["2026-11-17T03:03:41Z"],
  ]) {
    recusaCom(ruim, "RFC 3339", `entrada ${JSON.stringify(ruim)}`);
  }
});

Deno.test("texto com a forma certa e instante impossível é recusado (não vira NaN que passa)", () => {
  recusaCom("2026-13-45T25:61:61Z", "not a valid instant", "mês 13");
});
