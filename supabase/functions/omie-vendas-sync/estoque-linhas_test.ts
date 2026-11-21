// Testa o CÓDIGO REAL de estoque-linhas.ts no runtime real (Deno).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-vendas-sync/estoque-linhas_test.ts
//
// AUSENTE ≠ ZERO: produto do ListarPosEstoque sem `nSaldo` explícito não vira estoque 0 —
// fica de fora do UPDATE (o último saldo explícito permanece).
import { planejarLinhasEstoque } from "./estoque-linhas.ts";

function assertIgual(obtido: unknown, esperado: unknown, msg: string) {
  const a = JSON.stringify(obtido);
  const b = JSON.stringify(esperado);
  if (a !== b) throw new Error(`${msg}: obtido ${a} !== esperado ${b}`);
}

const IDS = new Map<number, string>([
  [1, "id-1"], [2, "id-2"], [3, "id-3"], [4, "id-4"], [5, "id-5"], [6, "id-6"], [7, "id-7"], [8, "id-8"],
]);
const T = "2026-11-21T12:00:00.000Z";

function estoquePorCodigo(produtos: Parameters<typeof planejarLinhasEstoque>[0]) {
  const plano = planejarLinhasEstoque(produtos, IDS, "oben", T);
  return {
    gravados: Object.fromEntries(plano.linhas.map((l) => [l.omie_codigo_produto, l.estoque])),
    semSaldo: plano.semSaldo,
  };
}

Deno.test("nSaldo ausente ou null: produto NÃO é gravado (nunca vira 0)", () => {
  const r = estoquePorCodigo([{ nCodProd: 1 }, { nCodProd: 2, nSaldo: null }]);
  assertIgual(r.gravados, {}, "ausente/null gravou estoque");
  assertIgual(r.semSaldo, [1, 2], "ausente/null não contado em semSaldo");
});

Deno.test("nSaldo lixo (vazio, branco, NaN, Infinity, boolean) também não é gravado", () => {
  const r = estoquePorCodigo([
    { nCodProd: 3, nSaldo: "" },
    { nCodProd: 4, nSaldo: "  " },
    { nCodProd: 5, nSaldo: Number.NaN },
    { nCodProd: 6, nSaldo: Number.POSITIVE_INFINITY },
    { nCodProd: 7, nSaldo: true },
  ]);
  assertIgual(r.gravados, {}, "lixo gravou estoque");
  assertIgual(r.semSaldo, [3, 4, 5, 6, 7], "lixo não contado em semSaldo");
});

Deno.test("zero REAL continua 0 e saldo explícito passa (inclusive string numérica)", () => {
  const r = estoquePorCodigo([
    { nCodProd: 1, nSaldo: 0 },
    { nCodProd: 2, nSaldo: 12.5 },
    { nCodProd: 3, nSaldo: -3 },
    { nCodProd: 4, nSaldo: "7" },
  ]);
  assertIgual(r.gravados, { "1": 0, "2": 12.5, "3": -3, "4": 7 }, "saldo explícito");
  assertIgual(r.semSaldo, [], "saldo explícito contado como ausente");
});

Deno.test("produto sem cadastro local ou código inválido é ignorado (sem contar como semSaldo)", () => {
  const r = estoquePorCodigo([
    { nCodProd: 999, nSaldo: 5 },
    { nCodProd: "x", nSaldo: 5 },
    { nCodProd: 999 },
    { nCodProd: [1], nSaldo: 5 }, // Number([1]) === 1 — não pode cair no SKU 1
    { nCodProd: true, nSaldo: 5 }, // Number(true) === 1
  ]);
  assertIgual(r.gravados, {}, "gravou produto sem cadastro");
  assertIgual(r.semSaldo, [], "produto sem cadastro contado em semSaldo");
});

// Fio do index.ts: o syncEstoque TEM de usar o planejador — uma regressão para `?? 0` no ponto
// de gravação deixaria os testes acima verdes se eles só provassem o módulo.
Deno.test("syncEstoque grava pelo planejarLinhasEstoque, sem fallback de nSaldo", async () => {
  const fonte = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  if (!/planejarLinhasEstoque\(produtos, existingMap, account, updatedAt\)/.test(fonte)) {
    throw new Error("index.ts: o syncEstoque nao chama planejarLinhasEstoque");
  }
  if (!/\.update\(\{ estoque: row\.estoque, updated_at: row\.updated_at \}\)/.test(fonte)) {
    throw new Error("index.ts: o UPDATE nao grava `estoque: row.estoque` do planejador");
  }
  if (!/totalSemSaldo,/.test(fonte)) {
    throw new Error("index.ts: a resposta do sync_estoque perdeu `totalSemSaldo`");
  }
  if (/nSaldo\s*(\?\?|\|\|)/.test(fonte)) {
    throw new Error("index.ts: fallback `nSaldo ??`/`||` reapareceu - fabrica o zero");
  }
});
