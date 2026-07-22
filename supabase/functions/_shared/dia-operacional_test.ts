// Testa o CÓDIGO REAL de dia-operacional.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/dia-operacional_test.ts
//
// POR QUE EXISTE — incidente 2026-07-21/22. A idempotência do generate-tactical-plan
// usava `created_at >= 00:00 UTC`, mas o dia operacional das vendedoras é BRT (UTC-3).
// Duas execuções do batch no MESMO dia 21 para o negócio (19:03 e 22:48 BRT) caíram em
// dias UTC diferentes (21 e 22) → a trava não pegou → 30 clientes ficaram com 2 planos.
//
// A janela UTC erra nos DOIS sentidos:
//   - run manual às 22:48 BRT      → NÃO pula (deveria) → duplicata
//   - cron às 05:00 BRT do dia D+1 → pula (não deveria) → dia sem plano
//
// `agora` é injetado: teste de fuso com relógio real é não-determinístico, e
// Date.now() varia entre a máquina de quem escreve e o CI.
import { inicioDiaOperacional } from "./dia-operacional.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg ?? `esperava ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}

Deno.test("00:00 BRT corresponde a 03:00 UTC do mesmo dia", () => {
  // meio-dia BRT do dia 21 = 15:00Z do dia 21
  assertEquals(
    inicioDiaOperacional(new Date("2026-07-21T15:00:00Z")),
    "2026-07-21T03:00:00.000Z",
  );
});

Deno.test("22:48 BRT do dia 21 (= 01:48Z do dia 22) ainda é o dia operacional 21", () => {
  // O caso EXATO do incidente: em UTC já virou dia 22, para o negócio ainda é 21.
  assertEquals(
    inicioDiaOperacional(new Date("2026-07-22T01:48:00Z")),
    "2026-07-21T03:00:00.000Z",
  );
});

Deno.test("05:00 BRT do dia 22 (= 08:00Z, horário do cron) é o dia operacional 22", () => {
  assertEquals(
    inicioDiaOperacional(new Date("2026-07-22T08:00:00Z")),
    "2026-07-22T03:00:00.000Z",
  );
});

Deno.test("exatamente 00:00 BRT é o início do próprio dia (borda inclusiva)", () => {
  assertEquals(
    inicioDiaOperacional(new Date("2026-07-21T03:00:00Z")),
    "2026-07-21T03:00:00.000Z",
  );
});

Deno.test("um segundo ANTES de 00:00 BRT ainda pertence ao dia anterior", () => {
  assertEquals(
    inicioDiaOperacional(new Date("2026-07-21T02:59:59Z")),
    "2026-07-20T03:00:00.000Z",
  );
});

Deno.test("23:59 BRT continua no mesmo dia operacional", () => {
  // 23:59 BRT do dia 21 = 02:59Z do dia 22
  assertEquals(
    inicioDiaOperacional(new Date("2026-07-22T02:59:00Z")),
    "2026-07-21T03:00:00.000Z",
  );
});

Deno.test("vira o mês corretamente", () => {
  // 22:00 BRT de 31/07 = 01:00Z de 01/08
  assertEquals(
    inicioDiaOperacional(new Date("2026-08-01T01:00:00Z")),
    "2026-07-31T03:00:00.000Z",
  );
});

Deno.test("vira o ANO corretamente", () => {
  // 22:00 BRT de 31/12/2026 = 01:00Z de 01/01/2027
  assertEquals(
    inicioDiaOperacional(new Date("2027-01-01T01:00:00Z")),
    "2026-12-31T03:00:00.000Z",
  );
});

// ── A invariante que o incidente exigiu ──────────────────────────────────────

Deno.test("os DOIS runs do incidente caem no mesmo dia operacional", () => {
  // Run 1: 2026-07-21T22:03Z = 19:03 BRT · Run 2: 2026-07-22T01:48Z = 22:48 BRT
  // Sob a janela UTC antiga davam dias diferentes → 30 duplicatas.
  const run1 = inicioDiaOperacional(new Date("2026-07-21T22:03:00Z"));
  const run2 = inicioDiaOperacional(new Date("2026-07-22T01:48:00Z"));
  assertEquals(run1, run2, "runs do mesmo dia BRT precisam compartilhar a janela");
});

Deno.test("o cron do dia seguinte NÃO herda a janela do dia anterior", () => {
  // Contrapartida: a janela não pode ser tão larga que o cron de D+1 pule o dia inteiro.
  const noite21 = inicioDiaOperacional(new Date("2026-07-22T01:48:00Z")); // 22:48 BRT dia 21
  const cron22 = inicioDiaOperacional(new Date("2026-07-22T08:00:00Z")); // 05:00 BRT dia 22
  if (noite21 === cron22) {
    throw new Error("dias operacionais distintos colapsaram — o cron pularia o dia 22");
  }
});
