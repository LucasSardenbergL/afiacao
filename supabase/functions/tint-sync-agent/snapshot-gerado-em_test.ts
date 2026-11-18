// snapshot-gerado-em_test.ts — o `generated_at` de /keys-snapshot não é escolha livre do emissor.
// Roda no CI via `bun run test:edges` (deno test --no-remote) — SEM import remoto.
//
// Money-path: `tint_apply_keys_snapshot` pula todo snapshot com generated_at <= último aplicado e
// grava o do aplicado em last_keys_snapshot_at. Um generated_at no futuro distante travava a
// desativação por snapshot para sempre. E a validação não pode recusar o que o conector real manda
// (`time.RFC3339`, medido na PROD entre 215 s e 261 s ATRÁS do relógio do servidor).
import { ADIANTAMENTO_MAXIMO_DO_SNAPSHOT_MS, validarGeradoEmDoSnapshot } from "./snapshot-gerado-em.ts";

function assertEq(atual: unknown, esperado: unknown, msg: string) {
  if (JSON.stringify(atual) !== JSON.stringify(esperado)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(atual)}`);
  }
}

/** Relógio do servidor fixo: 2026-11-17T03:07:30Z (o snapshot real da PROD foi gerado às 03:03:41Z). */
const AGORA = Date.parse("2026-11-17T03:07:30Z");

Deno.test("os formatos que o conector manda (time.RFC3339) passam, e o texto segue IGUAL para o banco", () => {
  for (const v of ["2026-11-17T03:03:41Z", "2026-11-17T00:03:41-03:00", "2026-11-17T03:03:41+00:00"]) {
    assertEq(validarGeradoEmDoSnapshot(v, AGORA), { ok: true, geradoEm: v }, v);
  }
});

Deno.test("fração de segundo (até nanossegundo) é aceita e não é reescrita", () => {
  for (const v of ["2026-11-17T03:03:41.5Z", "2026-11-17T03:03:41.123456Z", "2026-11-17T03:03:41.123456789Z"]) {
    assertEq(validarGeradoEmDoSnapshot(v, AGORA), { ok: true, geradoEm: v }, v);
  }
});

Deno.test("O FURO: generated_at no futuro distante é recusado", () => {
  for (const v of ["2099-01-01T00:00:00Z", "2026-11-18T03:07:30Z", "9999-12-31T23:59:59Z"]) {
    assertEq(validarGeradoEmDoSnapshot(v, AGORA), { ok: false, erro: "generated_at is in the future" }, v);
  }
});

Deno.test("a tolerância é a fronteira: até o teto passa, 1 segundo além é recusado", () => {
  assertEq(ADIANTAMENTO_MAXIMO_DO_SNAPSHOT_MS, 600_000, "teto de 10 minutos");
  const noTeto = new Date(AGORA + ADIANTAMENTO_MAXIMO_DO_SNAPSHOT_MS).toISOString().replace(".000Z", "Z");
  const alem = new Date(AGORA + ADIANTAMENTO_MAXIMO_DO_SNAPSHOT_MS + 1000).toISOString().replace(".000Z", "Z");
  assertEq(noTeto, "2026-11-17T03:17:30Z", "não-vacuidade: o instante do teto");
  assertEq(validarGeradoEmDoSnapshot(noTeto, AGORA).ok, true, "no teto passa");
  assertEq(validarGeradoEmDoSnapshot(alem, AGORA), { ok: false, erro: "generated_at is in the future" }, "1 s além do teto");
  // o fuso entra na conta: 00:17:31-03:00 é 03:17:31Z, 1 s além do teto
  assertEq(validarGeradoEmDoSnapshot("2026-11-17T00:17:31-03:00", AGORA).ok, false, "fuso -03:00 além do teto");
  assertEq(validarGeradoEmDoSnapshot("2026-11-17T00:17:30-03:00", AGORA).ok, true, "fuso -03:00 no teto");
  // adiantado dentro da tolerância (relógio da loja 5 min à frente) passa
  assertEq(validarGeradoEmDoSnapshot("2026-11-17T03:12:30Z", AGORA).ok, true, "5 min adiantado");
});

Deno.test("passado não tem piso: snapshot antigo passa aqui e é o banco que o pula como fora de ordem", () => {
  for (const v of ["2026-11-16T09:52:54Z", "2020-01-01T00:00:00Z", "1970-01-01T00:00:00Z"]) {
    assertEq(validarGeradoEmDoSnapshot(v, AGORA).ok, true, v);
  }
});

Deno.test("ausente segue sendo 'generated_at required'", () => {
  for (const v of [undefined, null, ""]) {
    assertEq(validarGeradoEmDoSnapshot(v, AGORA), { ok: false, erro: "generated_at required" }, String(v));
  }
});

Deno.test("o que não é texto é recusado — número (epoch) e objeto não viram data", () => {
  for (const v of [4070908800000, 0, true, { toString: "2026-11-17T03:03:41Z" }, ["2026-11-17T03:03:41Z"]]) {
    assertEq(validarGeradoEmDoSnapshot(v, AGORA), { ok: false, erro: "generated_at must be an RFC 3339 timestamp string" }, JSON.stringify(v));
  }
});

Deno.test("formato fora do RFC 3339 com fuso é recusado (JavaScript e Postgres poderiam ler instantes diferentes)", () => {
  const FORA = [
    "2026-11-17 03:03:41Z",        // espaço no lugar do T
    "2026-11-17T03:03:41",         // sem fuso
    "2026-11-17",                  // só data
    "17/11/2026 03:03:41",         // formato local
    "2026-11-17T03:03Z",           // sem segundos
    "2026-11-17t03:03:41z",        // minúsculas
    "2026-11-17T03:03:41+0300",    // fuso sem dois-pontos
    "2026-11-17T03:03:41.Z",       // fração vazia
    "2026-11-17T03:03:41.1234567890Z", // fração longa demais
    " 2026-11-17T03:03:41Z",       // espaço antes
    "2026-11-17T03:03:41Z\n",      // quebra de linha depois
    "2026-11-17T03:03:41Z; DROP",  // lixo depois
    "infinity",                    // o Postgres aceita 'infinity' como timestamptz
    "now",                         // e 'now'
    "tomorrow",
  ];
  for (const v of FORA) {
    assertEq(validarGeradoEmDoSnapshot(v, AGORA).ok, false, JSON.stringify(v));
    assertEq(
      validarGeradoEmDoSnapshot(v, AGORA),
      { ok: false, erro: "generated_at must be an RFC 3339 timestamp with timezone (YYYY-MM-DDTHH:MM:SSZ)" },
      JSON.stringify(v),
    );
  }
});

Deno.test("campos fora do calendário são recusados como data inválida", () => {
  const INVALIDAS = [
    "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z",   // mês
    "2026-11-00T00:00:00Z", "2026-11-31T00:00:00Z",   // dia que o mês não tem
    "2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z",   // fevereiro (2026 não é bissexto) — Date.parse rolaria para março
    "0000-01-01T00:00:00Z",                           // ano zero: o Postgres recusa
    "2026-11-17T24:00:00Z", "2026-11-17T25:00:00Z",   // hora
    "2026-11-17T03:60:00Z", "2026-11-17T03:61:00Z",   // minuto
    "2026-11-17T03:03:60Z",                           // segundo
    "2026-11-17T24:00:00.5Z",                         // hora 24 com fração
  ];
  for (const v of INVALIDAS) {
    assertEq(validarGeradoEmDoSnapshot(v, AGORA), { ok: false, erro: "generated_at is not a valid date" }, v);
  }
  // não-vacuidade: os vizinhos válidos passam (29 de fevereiro de ano bissexto, último segundo do dia)
  for (const v of ["2024-02-29T00:00:00Z", "2026-11-16T23:59:59Z", "2026-02-28T12:00:00Z", "0001-01-01T00:00:00Z"]) {
    assertEq(validarGeradoEmDoSnapshot(v, AGORA).ok, true, v);
  }
});

Deno.test("fuso fora da faixa é recusado; os extremos que existem passam", () => {
  for (const v of ["2026-11-17T03:03:41+23:59", "2026-11-17T03:03:41-15:00", "2026-11-17T03:03:41+14:01", "2026-11-17T03:03:41+03:60"]) {
    assertEq(validarGeradoEmDoSnapshot(v, AGORA), { ok: false, erro: "generated_at is not a valid date" }, v);
  }
  // todos no PASSADO do relógio fixo (03:07:30Z do dia 17): o que se testa aqui é a faixa do fuso
  for (const v of ["2026-11-17T03:03:41+14:00", "2026-11-16T03:03:41-12:00", "2026-11-17T03:03:41-00:00", "2026-11-16T23:33:41-03:30"]) {
    assertEq(validarGeradoEmDoSnapshot(v, AGORA).ok, true, v);
  }
  // e o fuso extremo válido ainda obedece ao teto: 03:03:41-12:00 do dia 17 é 15:03:41Z, no futuro
  assertEq(validarGeradoEmDoSnapshot("2026-11-17T03:03:41-12:00", AGORA), { ok: false, erro: "generated_at is in the future" }, "fuso válido, instante futuro");
});

Deno.test("a fração de segundo entra na conta do teto", () => {
  // teto = 03:17:30,000Z. Com a fração ignorada, 30,999999999 s passaria como 30 s.
  assertEq(validarGeradoEmDoSnapshot("2026-11-17T03:17:30.000Z", AGORA).ok, true, "no teto, com fração zero");
  assertEq(validarGeradoEmDoSnapshot("2026-11-17T03:17:29.999999999Z", AGORA).ok, true, "1 ns antes do teto");
  for (const v of ["2026-11-17T03:17:30.999999999Z", "2026-11-17T03:17:30.001Z", "2026-11-17T03:17:30.5Z"]) {
    assertEq(validarGeradoEmDoSnapshot(v, AGORA), { ok: false, erro: "generated_at is in the future" }, v);
  }
});

Deno.test("sem relógio do servidor não há como comparar: recusa, não aprova", () => {
  assertEq(validarGeradoEmDoSnapshot("2026-11-17T03:03:41Z", Number.NaN), { ok: false, erro: "server clock unavailable" }, "NaN");
  assertEq(validarGeradoEmDoSnapshot("2099-01-01T00:00:00Z", Number.POSITIVE_INFINITY), { ok: false, erro: "server clock unavailable" }, "Infinity");
});
