// snapshot-relogio_test.ts — o `generated_at` do /keys-snapshot não reserva o futuro
// (scanner Lovable, lote 6; achado do Codex no desenho). Roda no CI via `bun run test:edges`
// (deno test --no-remote) — SEM import remoto.
//
// O que está em jogo: o banco ordena os snapshots de chaves por `generated_at` e pula como "fora
// de ordem" o que vier com valor menor ou igual ao último aplicado. Um valor no futuro distante
// congelava a sincronização das retiradas do catálogo.
//
// A leitura do instante é do `instanteNs` (./preparacoes.ts, com teste próprio). Aqui se prova o
// que este módulo decide em cima dela: a fronteira da folga, o lado da comparação, a escala, e que
// o que o parser recusa não passa.
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
  assertEq(validarGeneratedAt("2026-11-17T03:03:41.123456Z", AGORA).ok, true, "fração de microssegundo");
  assertEq(validarGeneratedAt("2026-11-17T03:03:41.123456000Z", AGORA).ok, true, "9 dígitos com zeros além do micro");
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
  assertEq(validarGeneratedAt(iso(AGORA + 9 * 60_000), AGORA).ok, true, "9 min à frente passa");
  assertEq(validarGeneratedAt(iso(AGORA + TOLERANCIA_FUTURO_MS), AGORA).ok, true, "exatamente na tolerância passa");
  recusaCom(iso(AGORA + TOLERANCIA_FUTURO_MS + 1), "in the future", "1 ms além da tolerância");
  recusaCom(iso(AGORA + 11 * 60_000), "in the future", "11 min à frente");
});

Deno.test("fração abaixo do milissegundo conta: 1 microssegundo além da tolerância é recusado", () => {
  // 03:18:05 é exatamente AGORA + 10 min. O `Date.parse` jogava fora o que passa do milissegundo.
  assertEq(validarGeneratedAt("2026-11-17T03:18:05.000000Z", AGORA).ok, true, "fração zero, na fronteira");
  recusaCom("2026-11-17T03:18:05.000999Z", "in the future", "999 microssegundos além");
  recusaCom("2026-11-17T03:18:05.000001Z", "in the future", "1 microssegundo além");
  assertEq(validarGeneratedAt("2026-11-17T03:18:04.999999Z", AGORA).ok, true, "1 microssegundo antes da fronteira");
});

Deno.test("o fuso do texto é respeitado: -03:00 no futuro é futuro", () => {
  // 03:30 no fuso -03:00 = 06:30Z, mais de 3 horas à frente das 03:08Z do servidor.
  recusaCom("2026-11-17T03:30:00-03:00", "in the future", "offset que joga o instante para frente");
  // O mesmo relógio de parede com +03:00 é 00:30Z, no passado.
  assertEq(validarGeneratedAt("2026-11-17T03:30:00+03:00", AGORA).ok, true, "offset que joga para trás");
});

Deno.test("os MINUTOS do fuso contam", () => {
  // 03:40 em +00:30 é 03:10Z: dentro da folga das 03:08:05Z. Lido sem os 30 minutos seria 03:40Z, futuro.
  assertEq(validarGeneratedAt("2026-11-17T03:40:00+00:30", AGORA).ok, true, "+00:30 traz o instante para dentro da folga");
  // 03:00 em -00:30 é 03:30Z: futuro. Lido sem os 30 minutos seria 03:00Z, passado.
  recusaCom("2026-11-17T03:00:00-00:30", "in the future", "-00:30 leva o instante para o futuro");
});

Deno.test("o que não é RFC 3339 estrito com fuso é recusado — nada é adivinhado", () => {
  for (const ruim of [
    "2026-11-17T03:03:41", // sem fuso: ambíguo
    "2026-11-17 03:03:41+00:00", // espaço no lugar do T
    "2026-11-17t03:03:41z", // minúsculas
    "2026-11-17T03:03:41+0000", // fuso sem dois-pontos
    "2026-11-17T03:03:41+00", // fuso só com hora
    "2026-11-17T03:03:41.Z", // fração vazia
    "2026-11-17T03:03:41.1234567890Z", // fração com 10 dígitos
    "2026-11-17T03:03:41.123456789Z", // além do microssegundo: o Postgres arredondaria
    "2026-11-17T03:18:05.000000001Z", // idem, na fronteira da folga
    "2026-11-17",
    "2099",
    "ontem",
    "Tue, 17 Nov 2026 03:03:41 GMT",
    "2026-11-17T03:03:41Z; DROP",
    " 2026-11-17T03:03:41Z",
    "2026-11-17T03:03:41Z\n",
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

Deno.test("texto com a forma certa e instante que não existe é recusado ANTES de ir ao banco", () => {
  // O `Date.parse` rolava 30 de fevereiro para 2 de março; o Postgres recusa a data — e a rota
  // respondia 500 depois de tentar gravar.
  for (const ruim of [
    "2026-02-30T00:00:00Z", // 30 de fevereiro
    "2026-02-29T00:00:00Z", // 2026 não é bissexto
    "2026-13-01T00:00:00Z", // mês 13
    "2026-00-10T00:00:00Z", // mês 0
    "2026-11-00T00:00:00Z", // dia 0
    "2026-11-31T00:00:00Z", // novembro tem 30
    "2026-11-17T24:00:00Z", // 24h
    "2026-11-17T03:60:00Z", // minuto 60
    "2026-11-17T03:03:60Z", // segundo 60
    "2026-13-45T25:61:61Z",
    "0099-01-01T00:00:00Z", // ano fora da faixa
    "2026-11-17T03:03:41+16:00", // fuso além do que o Postgres aceita
    "2026-11-17T03:03:41-23:00", // idem
    "2026-11-17T03:03:41-03:60", // minuto de fuso 60
  ]) {
    recusaCom(ruim, "RFC 3339", `entrada ${ruim}`);
  }
  // Controle: o vizinho válido de cada caso passa.
  for (const bom of ["2024-02-29T00:00:00Z", "2025-11-30T23:59:59Z", "2026-11-17T03:03:41+15:59", "2026-11-16T03:03:41-03:59"]) {
    assertEq(validarGeneratedAt(bom, AGORA).ok, true, `vizinho válido ${bom}`);
  }
});
