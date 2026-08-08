// Testa o CÓDIGO REAL de tactical-fila.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/tactical-fila_test.ts
//
// POR QUE EXISTE — fase 2 da fila do Plano Tático (2026-08-08). A janela é a régua que
// decide se um cliente ainda está bloqueado para nova geração. Errar nela reabre a duplicata
// que o PR conserta (janela curta demais) ou cria um buraco silencioso onde o cliente sai da
// tela mas continua bloqueado (janela longa demais que a do front).
//
// `agora` é injetado: janela com relógio real é não-determinística e varia entre a máquina de
// quem escreve e o CI — mesmo padrão de dia-operacional_test.ts.
import { inicioDaJanelaFila, JANELA_FILA_DIAS } from "./tactical-fila.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg ?? `esperava ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}

function assertThrows(fn: () => unknown, msg: string) {
  let lancou = false;
  try {
    fn();
  } catch {
    lancou = true;
  }
  if (!lancou) throw new Error(msg);
}

Deno.test("janela é de 7 dias — o mesmo número do front e do cron de expiração", () => {
  // Se este assert quebrar, os TRÊS lugares precisam mudar juntos (ver o cabeçalho do módulo):
  // useTacticalPlan.ts:238, expirar_planos_taticos(_dias) e esta constante.
  assertEquals(JANELA_FILA_DIAS, 7);
});

Deno.test("recua exatamente 7×24h do instante dado", () => {
  assertEquals(
    inicioDaJanelaFila(new Date("2026-08-08T11:00:00.000Z")),
    "2026-08-01T11:00:00.000Z",
  );
});

Deno.test("é janela DESLIZANTE, não dia-calendário: preserva a hora do instante", () => {
  // O front usa `Date.now() - 7*86400000`. Se aqui a janela truncasse no dia, as duas pontas
  // discordariam sobre quem está na fila por até 24h todo dia — e a discordância é justamente
  // a duplicata (edge gera o que a tela já mostra) ou o buraco (tela esconde o que bloqueia).
  assertEquals(
    inicioDaJanelaFila(new Date("2026-08-08T23:59:59.000Z")),
    "2026-08-01T23:59:59.000Z",
  );
});

Deno.test("atravessa fronteira de mês sem cair no dia errado", () => {
  assertEquals(
    inicioDaJanelaFila(new Date("2026-03-03T09:30:00.000Z")),
    "2026-02-24T09:30:00.000Z",
  );
});

Deno.test("aceita janela custom >= 1", () => {
  assertEquals(
    inicioDaJanelaFila(new Date("2026-08-08T11:00:00.000Z"), 1),
    "2026-08-07T11:00:00.000Z",
  );
});

// ── Guard fail-closed (espelha o 22023 de expirar_planos_taticos) ───────────────────────────
// Com dias <= 0 a janela seria vazia ou futura: NENHUM plano aberto bloquearia, e a duplicata
// voltaria em silêncio — exatamente o bug que este PR remove. Falhar alto é o comportamento
// certo, porque um batch que não roda é visível e um batch que duplica não é.
Deno.test("dias = 0 levanta — janela vazia reabriria a duplicata", () => {
  assertThrows(
    () => inicioDaJanelaFila(new Date("2026-08-08T11:00:00.000Z"), 0),
    "esperava throw com dias=0",
  );
});

Deno.test("dias negativo levanta — janela no futuro não bloquearia ninguém", () => {
  assertThrows(
    () => inicioDaJanelaFila(new Date("2026-08-08T11:00:00.000Z"), -7),
    "esperava throw com dias negativo",
  );
});

Deno.test("dias NaN levanta — não degrada para a janela padrão", () => {
  // Cair no default silenciosamente esconderia um bug de configuração do chamador.
  assertThrows(
    () => inicioDaJanelaFila(new Date("2026-08-08T11:00:00.000Z"), NaN),
    "esperava throw com dias NaN",
  );
});
