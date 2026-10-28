// catalogo-vazio.ts — o lote de /catalogs que não traz NENHUMA entidade que esta edge grava.
//
// O conector manda, a cada ciclo, ~12 lotes de entidades que o servidor não usa (padracores,
// colecoes, subcolecoes, personcores — connector/sayersync/sync.go). A edge as ignorava, mas abria
// um run `catalogs` mesmo assim e o enfileirava para promoção: medido em 2026-10-21 (psql-ro),
// 696 de 986 runs de catálogo do dia com total_records = 0, cada um uma promoção vazia no tick.
// Esse lote agora recebe o MESMO ack, sem run e sem fila — nada dele era gravado antes nem agora.
//
// Money-path: o conector cacheia o hash do lote no 200 (só olha ok, error_count e errors). O ack
// sem run só sai quando NÃO há item gravável; qualquer item gravável segue o caminho normal, que
// só responde 200 com o enfileiramento confirmado (promocao-fila.ts).
//
// Testável com `deno test --no-remote` (catalogo-vazio_test.ts) — não reimplementar inline no index.

/** As chaves do payload que a rota /catalogs grava em staging (tint_staging_*). */
export const ENTIDADES_CATALOGO = ["produtos", "bases", "embalagens", "skus", "corantes", "precos_base"] as const;

/** Quantos itens GRAVÁVEIS o lote traz. Valor que não é array não conta (o index o trata como vazio). */
export function itensGravaveis(body: Record<string, unknown>): number {
  let n = 0;
  for (const k of ENTIDADES_CATALOGO) {
    const v = body[k];
    if (Array.isArray(v)) n += v.length;
  }
  return n;
}

/** O ack de um lote sem run: o mesmo corpo de antes, sem sync_run_id. Também o do reenvio idêntico de
 *  /formulas (formula-identica.ts), com `recebidos` = ignorados e o motivo próprio. */
export function ackSemRun(
  idempotencyKey: string | null,
  motivo = "nenhuma entidade gravável no lote",
  recebidos = 0,
): Record<string, unknown> {
  return {
    ok: true,
    sync_run_id: null,
    batch_id: idempotencyKey || null,
    idempotent_replay: false,
    received_count: recebidos,
    inserted_count: 0,
    updated_count: 0,
    ignored_count: recebidos,
    error_count: 0,
    errors: [],
    sem_run: motivo,
  };
}
