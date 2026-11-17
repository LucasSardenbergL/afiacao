// snapshot-gerado-em.ts — validação PURA do `generated_at` que a rota /keys-snapshot recebe.
//
// O que isto fecha (2ª opinião do Codex no lote 6 do scanner, 2026-11-17 — parente do conserto da
// rota /catalogs): o `generated_at` vem do corpo e é o RELÓGIO de precedência do snapshot de chaves.
// `tint_apply_keys_snapshot` pula como "fora de ordem" todo snapshot com generated_at <= último
// aplicado, e grava o do snapshot aplicado em `tint_integration_settings.last_keys_snapshot_at`.
// Um snapshot com generated_at em 2099 avançava a marca para 2099, e daí em diante todo snapshot
// honesto era pulado — inclusive depois de trocar o token. A rota só conferia que o campo existia.
//
// Contrato (cada linha tem teste em snapshot-gerado-em_test.ts):
//   · só RFC 3339 com data, hora e fuso explícitos (o que o conector manda: `time.RFC3339`, com o
//     relógio do PG de origem — connector/sayersync/sync.go). Formato fechado para o JavaScript e
//     o Postgres lerem o MESMO instante: o valor que segue para o banco é o texto original.
//   · instante adiantado em mais de ADIANTAMENTO_MAXIMO_DO_SNAPSHOT_MS em relação ao relógio do
//     servidor é RECUSADO (400). Não se "corrige para agora": inventar o instante da fotografia
//     mexeria na ordem que a promoção usa. Passado não tem piso: snapshot antigo já é pulado.
//
// Medido na PROD em 2026-11-17 (psql-ro), nos 27 snapshots da retenção: generated_at − created_at
// entre −260,7 s e −215,4 s. Nenhum adiantado; a folga até o teto é de mais de 13 minutos.
//
// Testável com `deno test --no-remote` — NÃO adicionar import remoto, NÃO reimplementar no index.

/** Quanto o relógio da origem pode estar à frente do relógio do servidor. */
export const ADIANTAMENTO_MAXIMO_DO_SNAPSHOT_MS = 10 * 60_000;

/** Data, hora e fuso explícitos; fração de segundo opcional (até nanossegundo). */
const RFC3339_DO_SNAPSHOT =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export type GeradoEmDoSnapshot =
  | { ok: true; geradoEm: string }
  | { ok: false; erro: string };

/**
 * Valida o `generated_at` do corpo. `agoraMs` é o relógio do servidor (Date.now()).
 * No sucesso devolve o MESMO texto recebido, para o banco gravar o que o conector mandou.
 */
export function validarGeradoEmDoSnapshot(valor: unknown, agoraMs: number): GeradoEmDoSnapshot {
  if (valor === undefined || valor === null || valor === "") {
    return { ok: false, erro: "generated_at required" };
  }
  if (typeof valor !== "string") {
    return { ok: false, erro: "generated_at must be an RFC 3339 timestamp string" };
  }
  const partes = RFC3339_DO_SNAPSHOT.exec(valor);
  if (!partes) {
    return { ok: false, erro: "generated_at must be an RFC 3339 timestamp with timezone (YYYY-MM-DDTHH:MM:SSZ)" };
  }
  // A fração de segundo fica fora da conta: o que se compara é o instante com folga de minutos.
  const instante = Date.parse(`${partes[1]}T${partes[2]}${partes[3]}`);
  if (!Number.isFinite(instante)) {
    return { ok: false, erro: "generated_at is not a valid date" };
  }
  if (!Number.isFinite(agoraMs)) {
    return { ok: false, erro: "server clock unavailable" };
  }
  if (instante > agoraMs + ADIANTAMENTO_MAXIMO_DO_SNAPSHOT_MS) {
    return { ok: false, erro: "generated_at is in the future" };
  }
  return { ok: true, geradoEm: valor };
}
