// Testa o CÓDIGO REAL de retry.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test supabase/functions/omie-sync-nfes-recebidas/retry_test.ts
//
// Cobre a decisão money-path do incidente OBEN de 05/07 (sync_nfes_recebidas caiu
// 12x): a Omie devolve HTTP 200 + faultstring transitório e o callOmie antigo só
// retentava rate-limit → abortava o ListarRecebimentos na 1ª página. As falsificações
// que importam: (a) "sem registros" NÃO pode virar retry (loop infinito / nunca
// completa); (b) 4xx NÃO pode virar retry (esconde credencial/param quebrado).
import {
  classifyOmieResponse,
  computeBackoffMs,
  isRateLimitOmieFault,
  isTransientOmieFault,
} from "./retry.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

// ── classifyOmieResponse: o coração da decisão de retry ──
Deno.test("classifyOmieResponse: faultstring transitório (HTTP 200) → retry (o incidente OBEN)", () => {
  assertEquals(classifyOmieResponse(200, "SOAP-ERROR: Encoding: string ..."), { kind: "retry", reason: "transient" });
  assertEquals(classifyOmieResponse(200, "ERROR: Application Server temporariamente indisponível"), { kind: "retry", reason: "transient" });
  assertEquals(classifyOmieResponse(200, "Broken response from upstream"), { kind: "retry", reason: "transient" });
  assertEquals(classifyOmieResponse(200, "connection timeout"), { kind: "retry", reason: "transient" });
});

Deno.test("classifyOmieResponse: rate-limit → retry/rate_limit", () => {
  assertEquals(classifyOmieResponse(200, "You have hit the rate limit"), { kind: "retry", reason: "rate_limit" });
  assertEquals(classifyOmieResponse(200, "Consumo redundante detectado"), { kind: "retry", reason: "rate_limit" });
  assertEquals(classifyOmieResponse(200, "REDUNDANT call"), { kind: "retry", reason: "rate_limit" });
  assertEquals(classifyOmieResponse(429, undefined), { kind: "retry", reason: "rate_limit" });
});

Deno.test("classifyOmieResponse: HTTP 5xx sem faultstring → retry/transient", () => {
  assertEquals(classifyOmieResponse(500, undefined), { kind: "retry", reason: "transient" });
  assertEquals(classifyOmieResponse(502, undefined), { kind: "retry", reason: "transient" });
  assertEquals(classifyOmieResponse(503, undefined), { kind: "retry", reason: "transient" });
});

// FALSIFICAÇÃO 1: "sem registros" é fim NORMAL — jamais retry (senão o sync nunca
// completa e gasta os 3 retries em toda página vazia).
Deno.test("classifyOmieResponse: 'sem registros' NÃO é transitório → fault (caller decide fim)", () => {
  assertEquals(classifyOmieResponse(200, "Não existem registros para a página"), { kind: "fault" });
  assertEquals(classifyOmieResponse(200, "Nenhum registro encontrado"), { kind: "fault" });
});

// FALSIFICAÇÃO 2: 4xx permanente jamais retry — precisa falhar alto (credencial/param).
Deno.test("classifyOmieResponse: 4xx (não-429) → permanent, nunca mascarado por retry", () => {
  assertEquals(classifyOmieResponse(400, undefined), { kind: "permanent" });
  assertEquals(classifyOmieResponse(401, undefined), { kind: "permanent" });
  assertEquals(classifyOmieResponse(403, undefined), { kind: "permanent" });
  assertEquals(classifyOmieResponse(404, undefined), { kind: "permanent" });
});

Deno.test("classifyOmieResponse: 2xx limpo → ok", () => {
  assertEquals(classifyOmieResponse(200, undefined), { kind: "ok" });
});

// Precedência: faultstring transitório vence o status HTTP (Omie manda 200 + fault).
Deno.test("classifyOmieResponse: faultstring de negócio (não transitório) → fault", () => {
  assertEquals(classifyOmieResponse(200, "Cliente não cadastrado no ERP"), { kind: "fault" });
});

// ── computeBackoffMs: parse "Aguarde N" + progressivo, teto 15s ──
Deno.test("computeBackoffMs: parseia 'Aguarde N segundos' e aplica +2, teto 15s", () => {
  assertEquals(computeBackoffMs("Aguarde 3 segundos e tente novamente", 0), 5000);   // (3+2)*1000
  assertEquals(computeBackoffMs("Aguarde 20 segundos", 0), 15000);                    // (20+2) capado em 15
});

Deno.test("computeBackoffMs: sem 'Aguarde' → progressivo por tentativa, teto 15s", () => {
  assertEquals(computeBackoffMs("SOAP-ERROR", 0), 7000);   // (1*5+2)*1000
  assertEquals(computeBackoffMs("SOAP-ERROR", 1), 12000);  // (2*5+2)*1000
  assertEquals(computeBackoffMs("SOAP-ERROR", 2), 15000);  // (3*5+2)=17 → teto 15
});

// ── helpers de vocabulário (sanidade) ──
Deno.test("isTransientOmieFault / isRateLimitOmieFault: vocabulário e negativos", () => {
  assertEquals(isTransientOmieFault("SOAP-ERROR"), true);
  assertEquals(isTransientOmieFault("Application Server down"), true);
  assertEquals(isTransientOmieFault("sem registros"), false);
  assertEquals(isRateLimitOmieFault("rate limit exceeded"), true);
  assertEquals(isRateLimitOmieFault("SOAP-ERROR"), false);
});
