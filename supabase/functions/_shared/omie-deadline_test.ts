// Testa o CÓDIGO REAL de omie-deadline.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/omie-deadline_test.ts
//
// O que estes casos protegem, em ordem de custo: (1) um request individual não pode cruzar o
// deadline do run — é o que sobra quando só se põe `AbortSignal.timeout(25s)` fixo; (2) um sleep
// de retry que cabe no deadline mas não deixa tempo para a chamada seguinte só adia o kill; (3) o
// lado seguro do arredondamento é NÃO CHAMAR, nunca "chamar com o que sobrou".
import { cabeEspera, MIN_REQUEST_MS, tempoRestanteMs, timeoutRequestMs } from "./omie-deadline.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg ?? `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}

const T0 = 1_000_000; // relógio fixo: nada aqui pode depender de Date.now()

Deno.test("tempoRestanteMs: sobra normal, vencido e entrada não-finita", () => {
  assertEquals(tempoRestanteMs(T0, T0 + 30_000), 30_000);
  assertEquals(tempoRestanteMs(T0, T0), 0, "deadline exatamente agora = 0");
  assertEquals(tempoRestanteMs(T0, T0 - 5_000), 0, "vencido nunca devolve negativo");
  assertEquals(tempoRestanteMs(NaN, T0 + 30_000), 0, "NaN cai no lado seguro");
  assertEquals(tempoRestanteMs(T0, Infinity), 0, "deadline não-finito cai no lado seguro");
});

Deno.test("timeoutRequestMs: com tempo de sobra, vale o teto por request", () => {
  assertEquals(timeoutRequestMs(T0, T0 + 120_000, 25_000), 25_000);
});

Deno.test("timeoutRequestMs: perto do fim, o RESTANTE manda — o request não cruza o deadline", () => {
  // O furo do teto fixo: faltando 8s para o kill, `AbortSignal.timeout(25_000)` deixaria o
  // request atravessar o kill e matar o isolate sem catch (log órfão `running`).
  assertEquals(timeoutRequestMs(T0, T0 + 8_000, 25_000), 8_000);
});

Deno.test("timeoutRequestMs: sem tempo viável devolve 0 (não chame) em vez do resto", () => {
  assertEquals(timeoutRequestMs(T0, T0 + 1_999, 25_000), 0, "abaixo do piso = recusa");
  assertEquals(timeoutRequestMs(T0, T0, 25_000), 0, "deadline vencido = recusa");
  assertEquals(timeoutRequestMs(T0, T0 - 60_000, 25_000), 0, "kill já passou = recusa");
});

Deno.test("timeoutRequestMs: o piso é INCLUSIVO — restante == mínimo ainda chama", () => {
  assertEquals(timeoutRequestMs(T0, T0 + MIN_REQUEST_MS, 25_000), MIN_REQUEST_MS);
});

Deno.test("timeoutRequestMs: teto inválido nunca vira 'sem limite'", () => {
  assertEquals(timeoutRequestMs(T0, T0 + 120_000, 0), 0);
  assertEquals(timeoutRequestMs(T0, T0 + 120_000, -1), 0);
  assertEquals(timeoutRequestMs(T0, T0 + 120_000, NaN), 0);
  assertEquals(timeoutRequestMs(T0, T0 + 120_000, Infinity), 0, "Infinity é ausência de coleira");
});

Deno.test("timeoutRequestMs: devolve inteiro (AbortSignal.timeout não quer fração)", () => {
  assertEquals(timeoutRequestMs(T0, T0 + 120_000, 25_000.7), 25_000);
});

Deno.test("cabeEspera: backoff curto com muito tempo pela frente", () => {
  assertEquals(cabeEspera(T0, T0 + 120_000, 2_000), true);
});

Deno.test("cabeEspera: sleep que sozinho já cruza o deadline", () => {
  assertEquals(cabeEspera(T0, T0 + 5_000, 20_000), false);
});

Deno.test("cabeEspera: sleep que CABE mas não deixa tempo para o request seguinte", () => {
  // O caso sutil, e a razão do helper existir: `agora + espera < deadline` é verdadeiro
  // (10s de sleep contra 11s de sobra) e mesmo assim dormir só adia o kill — sobra 1s, que
  // não paga nem o handshake. Um guard escrito só como `Date.now() + backoff >= deadline`
  // aprovaria esta retentativa.
  assertEquals(cabeEspera(T0, T0 + 11_000, 10_000), false);
});

Deno.test("cabeEspera: o limiar é INCLUSIVO — espera + mínimo == restante ainda cabe", () => {
  assertEquals(cabeEspera(T0, T0 + 10_000 + MIN_REQUEST_MS, 10_000), true);
  assertEquals(cabeEspera(T0, T0 + 10_000 + MIN_REQUEST_MS - 1, 10_000), false);
});

Deno.test("cabeEspera: espera inválida é recusa, não passe-livre", () => {
  assertEquals(cabeEspera(T0, T0 + 120_000, -1), false);
  assertEquals(cabeEspera(T0, T0 + 120_000, NaN), false);
  assertEquals(cabeEspera(T0, T0 + 120_000, Infinity), false);
});

Deno.test("cabeEspera: deadline vencido recusa qualquer espera, inclusive zero", () => {
  assertEquals(cabeEspera(T0, T0 - 1, 0), false);
});
