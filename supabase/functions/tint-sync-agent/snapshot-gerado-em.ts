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
//     relógio do PG de origem — connector/sayersync/sync.go). Formato fechado e calendário
//     conferido campo a campo (dia que existe, hora até 23, segundo até 59, fuso até ±14:00), para
//     o JavaScript e o Postgres lerem o MESMO instante: o valor que segue para o banco é o texto
//     original.
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
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

/** Maior deslocamento de fuso aceito: ±14:00, o maior que existe (o Postgres iria até ±15:59). */
const FUSO_MAXIMO_DO_SNAPSHOT_MIN = 14 * 60;

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
  const p = RFC3339_DO_SNAPSHOT.exec(valor);
  if (!p) {
    return { ok: false, erro: "generated_at must be an RFC 3339 timestamp with timezone (YYYY-MM-DDTHH:MM:SSZ)" };
  }
  const ano = Number(p[1]), mes = Number(p[2]), dia = Number(p[3]);
  const hora = Number(p[4]), minuto = Number(p[5]), segundo = Number(p[6]);
  const fracaoMs = p[7] ? Number(`0.${p[7]}`) * 1000 : 0;
  const fusoMin = p[8] === "Z" ? 0 : (p[9] === "-" ? -1 : 1) * (Number(p[10]) * 60 + Number(p[11]));

  // Calendário conferido campo a campo, e não por Date.parse: ele rola 30 de fevereiro para março e
  // aceita o ano 0000, que o Postgres recusa — a rota responderia 500 no lugar do 400. Hora 24 e
  // segundo 60, que o Postgres normaliza, ficam de fora: o conector não os produz.
  const civil = new Date(0);
  civil.setUTCFullYear(ano, mes - 1, dia);
  civil.setUTCHours(hora, minuto, segundo, 0);
  const camposNaFaixa = ano >= 1 && mes >= 1 && mes <= 12 && dia >= 1 && hora <= 23 && minuto <= 59 && segundo <= 59;
  const diaExiste = civil.getUTCFullYear() === ano && civil.getUTCMonth() === mes - 1 && civil.getUTCDate() === dia;
  const fusoNaFaixa = p[8] === "Z" || (Number(p[11]) <= 59 && Math.abs(fusoMin) <= FUSO_MAXIMO_DO_SNAPSHOT_MIN);
  if (!camposNaFaixa || !diaExiste || !fusoNaFaixa) {
    return { ok: false, erro: "generated_at is not a valid date" };
  }
  // A fração entra na conta: sem ela, 30,999999999 s passaria como 30 s cravados no teto.
  const instante = civil.getTime() - fusoMin * 60_000 + fracaoMs;
  if (!Number.isFinite(agoraMs)) {
    return { ok: false, erro: "server clock unavailable" };
  }
  if (instante > agoraMs + ADIANTAMENTO_MAXIMO_DO_SNAPSHOT_MS) {
    return { ok: false, erro: "generated_at is in the future" };
  }
  return { ok: true, geradoEm: valor };
}
