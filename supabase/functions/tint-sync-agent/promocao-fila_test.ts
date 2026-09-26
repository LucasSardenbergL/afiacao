// promocao-fila_test.ts — contrato da promoção assíncrona na fronteira edge→conector.
// Roda no CI via `bun run test:edges` (deno test --no-remote) — SEM import remoto.
//
// Money-path: o conector cacheia o hash do lote no 200. Se a edge responder 200 sem o run
// estar na fila, o lote nunca é promovido e ninguém re-envia — o dado some calado.
import {
  camposDeEnfileiramento,
  corpoDeConclusao,
  PROMOCAO_PENDENTE,
  respostaDeConclusao,
  snapshotEnfileirado,
  updateConfirmou,
} from "./promocao-fila.ts";

function assertEq(atual: unknown, esperado: unknown, msg: string) {
  if (JSON.stringify(atual) !== JSON.stringify(esperado)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(atual)}`);
  }
}

Deno.test("só automatic_primary enfileira — demais modos seguem sem promoção", () => {
  assertEq(camposDeEnfileiramento("automatic_primary"), { promocao_status: "pendente" }, "automatic_primary");
  for (const modo of ["manual", "shadow", "automatic_secondary", "", "AUTOMATIC_PRIMARY"]) {
    assertEq(camposDeEnfileiramento(modo), undefined, `modo ${JSON.stringify(modo)}`);
  }
});

Deno.test("corpo da conclusão anuncia 'pendente' só quando enfileirou (e preserva o resto)", () => {
  const resp = { ok: true, sync_run_id: "r1", received_count: 3 };
  assertEq(corpoDeConclusao(resp, true), { ...resp, promocao: PROMOCAO_PENDENTE }, "enfileirou");
  assertEq(corpoDeConclusao(resp, false), resp, "não enfileirou");
  assertEq(resp, { ok: true, sync_run_id: "r1", received_count: 3 }, "não muta o resp original");
});

Deno.test("UPDATE só confirma com exatamente 1 linha e sem erro", () => {
  assertEq(updateConfirmou([{ id: "r1" }], null), true, "1 linha");
  assertEq(updateConfirmou([], null), false, "0 linhas (run sumiu / filtro não casou)");
  assertEq(updateConfirmou([{ id: "a" }, { id: "b" }], null), false, "2 linhas");
  assertEq(updateConfirmou(null, null), false, "data ausente NÃO é confirmação");
  assertEq(updateConfirmou(undefined, null), false, "data undefined");
  assertEq(updateConfirmou([{ id: "r1" }], { message: "PGRST204" }), false, "erro com data");
});

Deno.test("sem confirmação → 500 + retry (o conector NÃO cacheia o lote)", () => {
  const corpo = { ok: true, promocao: "pendente" };
  const falhou = respostaDeConclusao(false, corpo);
  assertEq(falhou.status, 500, "status");
  assertEq(falhou.body.ok, false, "ok=false (o conector exige ok:true para cachear)");
  assertEq(falhou.body.retry, true, "retry");
  const passou = respostaDeConclusao(true, corpo);
  assertEq(passou.status, 200, "status ok");
  assertEq(passou.body, corpo, "corpo ok");
});

Deno.test("snapshot: enfileirado só com as duas pontas limpas e contagem ZERO — null é 'não sei'", () => {
  assertEq(snapshotEnfileirado(null, null, 0), true, "limpo");
  assertEq(snapshotEnfileirado(null, null, null), false, "contagem ausente");
  assertEq(snapshotEnfileirado(null, null, undefined), false, "contagem undefined");
  assertEq(snapshotEnfileirado(null, null, 1), false, "linha sem estado");
  assertEq(snapshotEnfileirado({ message: "x" }, null, 0), false, "UPDATE errou");
  assertEq(snapshotEnfileirado(null, { message: "x" }, 0), false, "conferência errou");
});
