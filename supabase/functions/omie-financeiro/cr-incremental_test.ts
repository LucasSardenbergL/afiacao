// Testa o CÓDIGO REAL de cr-incremental.ts no runtime real (Deno).
// Roda com: deno test supabase/functions/omie-financeiro/cr-incremental_test.ts
import { decidirModoCR, FULL_MAX_DIAS, janelaAlteracao } from "./cr-incremental.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

// Domingo 01/11/2026 22:30 BRT = 02/11 01:30 UTC — o dia de negócio é 01/11, não 02/11.
const AGORA = new Date("2026-11-02T01:30:00Z");
const h = (iso: string) => new Date(iso);

Deno.test("cursor pendente continua o full, mesmo com estado novo", () => {
  assertEquals(
    decidirModoCR({ cursorPendente: true, estado: { fullOkEm: h("2026-11-01T10:00:00Z"), incrementalOkEm: null }, agora: AGORA }),
    { modo: "continuar_full" },
  );
});

Deno.test("estado ilegível cai no full (comportamento de antes do lote), nunca no incremental", () => {
  assertEquals(decidirModoCR({ cursorPendente: false, estado: null, agora: AGORA }), { modo: "full", motivo: "estado_ilegivel" });
});

Deno.test("sem full completo ainda: full (bootstrap), mesmo com incremental registrado", () => {
  assertEquals(
    decidirModoCR({ cursorPendente: false, estado: { fullOkEm: null, incrementalOkEm: h("2026-11-01T10:00:00Z") }, agora: AGORA }),
    { modo: "full", motivo: "sem_full" },
  );
});

Deno.test("full com mais de 7 dias vence, por mais recente que seja o incremental", () => {
  const fullOk = new Date(AGORA.getTime() - (FULL_MAX_DIAS * 86_400_000 + 60_000));
  assertEquals(
    decidirModoCR({ cursorPendente: false, estado: { fullOkEm: fullOk, incrementalOkEm: h("2026-11-01T17:20:00Z") }, agora: AGORA }),
    { modo: "full", motivo: "full_vencido" },
  );
  // 1 min ANTES do limite segue incremental (o par: separa "vence" de "sempre full").
  const fullOkDentro = new Date(AGORA.getTime() - (FULL_MAX_DIAS * 86_400_000 - 60_000));
  assertEquals(
    decidirModoCR({ cursorPendente: false, estado: { fullOkEm: fullOkDentro, incrementalOkEm: null }, agora: AGORA }).modo,
    "incremental",
  );
});

Deno.test("marca = o mais recente entre full e incremental; janela volta 1 dia e vai até HOJE em SP", () => {
  // incremental às 14:20 BRT de 01/11 → marca 01/11 → de 31/10 até 01/11 (não 02/11: ainda é domingo em SP)
  assertEquals(
    decidirModoCR({
      cursorPendente: false,
      estado: { fullOkEm: h("2026-10-29T08:20:00Z"), incrementalOkEm: h("2026-11-01T17:20:00Z") },
      agora: AGORA,
    }),
    { modo: "incremental", de: "31/10/2026", ate: "01/11/2026", marca: "2026-11-01" },
  );
  // incremental mais VELHO que o full: a marca é o início do full
  assertEquals(
    decidirModoCR({
      cursorPendente: false,
      estado: { fullOkEm: h("2026-10-30T11:00:00Z"), incrementalOkEm: h("2026-10-29T11:20:00Z") },
      agora: AGORA,
    }),
    { modo: "incremental", de: "29/10/2026", ate: "01/11/2026", marca: "2026-10-30" },
  );
});

Deno.test("marca pelo dia de SP, não UTC: run às 22:30 BRT marca o próprio dia", () => {
  // t0 = 01/11 22:30 BRT (02/11 01:30 UTC); o próximo run, 02/11 05:20 BRT, lista de 31/10 (não de 01/11)
  assertEquals(
    janelaAlteracao(h("2026-11-02T01:30:00Z"), h("2026-11-02T08:20:00Z")),
    { de: "31/10/2026", ate: "02/11/2026", marca: "2026-11-01" },
  );
});

Deno.test("marca no futuro lança (relógio/estado corrompido não vira janela vazia)", () => {
  let msg = "";
  try {
    janelaAlteracao(h("2026-11-03T12:00:00Z"), AGORA);
  } catch (e) {
    msg = String(e);
  }
  if (!msg.includes("marca no futuro")) throw new Error(`esperava 'marca no futuro', veio [${msg}]`);
});
