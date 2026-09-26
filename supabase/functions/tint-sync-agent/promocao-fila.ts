// promocao-fila.ts — decisões PURAS da promoção assíncrona (migration 20260925210000).
//
// A edge não promove mais dentro do HTTP: o promote de lote grande passava dos ~128s do gateway
// (500 + reenvio diário de ~500k linhas + lock timeout nos requests seguintes). Ela grava o
// staging, ENFILEIRA no mesmo UPDATE que fecha o run e responde; o cron tint-promocao-tick
// promove. O ponto money-path desta fronteira: o conector cacheia o hash do lote quando recebe
// ok — então o 200 só pode sair com o enfileiramento CONFIRMADO. Um 200 sem a linha na fila é
// um lote que nunca entra e que ninguém re-envia.
//
// Testável com `deno test --no-remote` (promocao-fila_test.ts) — não reimplementar inline no index.

export const PROMOCAO_PENDENTE = "pendente";

/** Campos que entram no MESMO UPDATE que marca o run `complete`. Só `automatic_primary`
 *  enfileira — nos demais modos não havia promoção e continua não havendo. */
export function camposDeEnfileiramento(integrationMode: string): Record<string, string> | undefined {
  return integrationMode === "automatic_primary" ? { promocao_status: PROMOCAO_PENDENTE } : undefined;
}

/** Corpo que vai ao conector E fica gravado como idempotency_response (o replay devolve igual). */
export function corpoDeConclusao(
  resp: Record<string, unknown>,
  enfileirou: boolean,
): Record<string, unknown> {
  return enfileirou ? { ...resp, promocao: PROMOCAO_PENDENTE } : resp;
}

/** O UPDATE confirmou a linha? Exatamente 1 linha devolvida e nenhum erro — `data` ausente
 *  (PostgREST sem representação) NÃO é confirmação. */
export function updateConfirmou(data: unknown, error: unknown): boolean {
  return !error && Array.isArray(data) && data.length === 1;
}

/** 200 com o corpo só se o run fechou (e enfileirou) de verdade; senão 500 + retry, para o
 *  conector NÃO cachear o lote e re-enviar. */
export function respostaDeConclusao(
  confirmou: boolean,
  corpo: Record<string, unknown>,
): { status: number; body: Record<string, unknown> } {
  if (!confirmou) {
    return { status: 500, body: { ok: false, error: "failed to complete/enqueue sync run", retry: true } };
  }
  return { status: 200, body: corpo };
}

/** Snapshot de chaves: enfileirado só se o UPDATE não errou E a conferência POR FORA achou zero
 *  linhas do snapshot sem estado. Contagem ausente (null) é "não sei", nunca zero. */
export function snapshotEnfileirado(
  updateErro: unknown,
  conferenciaErro: unknown,
  linhasSemEstado: number | null | undefined,
): boolean {
  return !updateErro && !conferenciaErro && linhasSemEstado === 0;
}

/** Chunks recebidos do snapshot: a contagem só vale sem erro e como número. Contagem que
 *  falhou é "não sei" (null) — tratá-la como 0 respondia 200 `complete:false` ao ÚLTIMO chunk,
 *  o conector avançava e o snapshot nunca entrava na fila (Codex, revisão do diff). */
export function chunksRecebidos(count: number | null | undefined, error: unknown): number | null {
  return !error && typeof count === "number" ? count : null;
}
