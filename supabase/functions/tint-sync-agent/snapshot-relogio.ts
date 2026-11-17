// snapshot-relogio.ts — o `generated_at` do /keys-snapshot não pode reservar o futuro.
// Puro, sem import remoto: roda sob `deno test --no-remote` (snapshot-relogio_test.ts).
// O index.ts importa daqui — NÃO reimplementar inline.
//
// Por que existe (scanner Lovable Security, lote 6 — 2026-11-17; achado do Codex no desenho):
// o `generated_at` vem do agente (é o relógio do PostgreSQL de ORIGEM, na loja) e a edge o gravava
// sem olhar. É por ele que o banco ordena os snapshots de chaves:
//   · `tint_apply_keys_snapshot` pula como "fora de ordem" todo snapshot com
//     `generated_at <= last_keys_snapshot_at` e, ao aplicar, grava o do snapshot como novo marco;
//   · `tint_promote_sync_run`, `tint_receita_versoes_capturar` e `tint_watchdog_fase5_check`
//     escolhem o snapshot de referência pelo maior `generated_at`.
// Um snapshot com `generated_at` em 2099 virava o marco para sempre: todo snapshot legítimo
// seguinte era pulado, mesmo depois de o token ser trocado. É o mesmo furo da cópia genérica do
// /catalogs (`created_at` escolhido pelo agente), por outra porta.
//
// A regra: o instante tem de ser legível e não pode estar à frente do relógio do servidor além
// de uma tolerância. Quem ainda manda um instante adiantado dentro da tolerância só atrasa os
// snapshots seguintes por esse mesmo tanto.
//
// Medido na PROD em 2026-11-17 (81 linhas, 27 snapshots em 30 dias): o `generated_at` está
// SEMPRE atrás do recebimento, entre 3min35s e 4min24s (é o tempo de gerar e enviar). Nenhum
// snapshot legítimo chegou adiantado; 10 minutos de folga cobrem um relógio de loja fora de
// sincronia sem deixar o marco andar mais do que isso.

/** Folga para relógio adiantado na origem. Passou disso, o snapshot é recusado (400). */
export const TOLERANCIA_FUTURO_MS = 10 * 60_000;

// RFC 3339 com fuso EXPLÍCITO (o conector manda `time.RFC3339`). Sem fuso o instante é ambíguo:
// o JavaScript e o Postgres poderiam ler horas diferentes do mesmo texto.
const RE_RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export type VeredictoRelogio = { ok: true } | { ok: false; erro: string };

/**
 * `valor` é o `generated_at` do body; `agoraMs` é o relógio do SERVIDOR (`Date.now()`).
 * Não normaliza nem devolve o instante: quem passa é gravado exatamente como veio.
 */
export function validarGeneratedAt(valor: unknown, agoraMs: number): VeredictoRelogio {
  if (typeof valor !== "string" || !RE_RFC3339.test(valor)) {
    return { ok: false, erro: "generated_at must be an RFC 3339 timestamp with timezone" };
  }
  const ms = Date.parse(valor);
  if (!Number.isFinite(ms)) {
    return { ok: false, erro: "generated_at is not a valid instant" };
  }
  if (ms > agoraMs + TOLERANCIA_FUTURO_MS) {
    return {
      ok: false,
      erro: `generated_at is in the future (server clock: ${new Date(agoraMs).toISOString()})`,
    };
  }
  return { ok: true };
}
