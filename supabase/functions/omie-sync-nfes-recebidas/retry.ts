// Classificação de erro da Omie para retry — vocabulário alinhado às edges irmãs
// (omie-vendas-sync/index.ts). PURO e testável (retry_test.ts) porque a decisão
// "retentar × devolver × falhar alto" é onde os bugs de money-path moram: retentar
// um 4xx permanente esconde erro de credencial/param; NÃO retentar um SOAP-ERROR
// transitório aborta o sync (o incidente OBEN de 05/07). O callOmie é só o
// encanamento que executa o veredito.

// Rate-limit / consumo redundante da Omie → retry com backoff.
export function isRateLimitOmieFault(fs: string): boolean {
  return /rate limit/i.test(fs)
    || fs.includes("Já existe uma requisição desse método")
    || /consumo redundante/i.test(fs)
    || fs.includes("REDUNDANT");
}

// Transitório do lado da Omie (SOAP/app server/timeout) → retry com backoff.
export function isTransientOmieFault(fs: string): boolean {
  return fs.includes("SOAP-ERROR")
    || fs.includes("Broken response")
    || fs.includes("Application Server")
    || /timeout/i.test(fs);
}

export type OmieRetryVerdict =
  | { kind: "ok" }                                          // 2xx sem faultstring → seguir
  | { kind: "retry"; reason: "rate_limit" | "transient" }  // transitório → backoff + retry
  | { kind: "fault" }                                       // faultstring de negócio (ex.: "sem registros") → caller decide
  | { kind: "permanent" };                                 // 4xx não-429 → falha alta (param/auth/contrato)

// Decide o que fazer com uma resposta da Omie a partir do status HTTP + faultstring.
// Ordem importa: faultstring transitório/rate-limit vence o status (a Omie devolve
// HTTP 200 + faultstring transitório). 429 e 5xx SEM faultstring também retentam;
// 4xx (400/401/403/404) é permanente e precisa falhar alto, nunca ser mascarado
// por retry. "fault" devolve ao caller — o syncEmpresa distingue "sem registros"
// (fim normal) de erro de negócio.
export function classifyOmieResponse(
  status: number,
  faultstring: string | undefined,
): OmieRetryVerdict {
  if (faultstring) {
    const fs = String(faultstring);
    if (isRateLimitOmieFault(fs)) return { kind: "retry", reason: "rate_limit" };
    if (isTransientOmieFault(fs)) return { kind: "retry", reason: "transient" };
    return { kind: "fault" };
  }
  if (status === 429) return { kind: "retry", reason: "rate_limit" };
  if (status >= 500) return { kind: "retry", reason: "transient" };
  if (status >= 400) return { kind: "permanent" };
  return { kind: "ok" };
}

// Delay de backoff (ms). Parseia "Aguarde N segundos" da Omie; senão progressivo
// por tentativa. Mesma fórmula das irmãs: min(requested + 2, 15) * 1000 (teto 15s).
export function computeBackoffMs(fs: string, attempt: number): number {
  const waitMatch = fs.match(/Aguarde (\d+) segundos/);
  const requestedDelay = waitMatch ? parseInt(waitMatch[1], 10) : (attempt + 1) * 5;
  return Math.min(requestedDelay + 2, 15) * 1000;
}
