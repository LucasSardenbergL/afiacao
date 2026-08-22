// O acoplamento PAGE ↔ max-rows do PostgREST, nos DOIS helpers.
//
// `PAGE` é 1000 e o `max-rows` medido em prod é 1000 — o laço pede exatamente o cap e funciona
// por coincidência numérica, que nada vigia. Se o cap baixasse, "página curta" deixaria de
// significar "acabou" e as leituras truncariam EM SILÊNCIO: a classe do #1836, por outra porta.
//
// A saída registrada antes em docs/historico/paginacao-offset-janela.md era baixar PAGE para 900.
// Ela é fraca: protege só contra caps entre 900 e 999 (com cap 500, `500 < 900` continua sendo
// lido como EOF) e ainda paga +11% de requests em TODA leitura. Estes testes exigem a robusta —
// EOF por página VAZIA e avanço pelo número REAL de linhas devolvidas —, que vale para qualquer cap.
import { fetchAll, fetchAllKeyset } from "./paginate.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const TOTAL = 2300;
const CAP_DO_SERVIDOR = 500; // menor que PAGE (1000), que é o cenário não vigiado

Deno.test("fetchAll: servidor com max-rows MENOR que PAGE devolve a tabela INTEIRA", () => {
  const todas = Array.from({ length: TOTAL }, (_, i) => ({ id: i }));
  let calls = 0;
  const build = (from: number, to: number) => {
    calls++;
    if (calls > 40) throw new Error("laço não converge");
    // O PostgREST honra o range MAS trunca em max-rows: devolve no máximo CAP linhas.
    const janela = todas.slice(from, to + 1).slice(0, CAP_DO_SERVIDOR);
    return Promise.resolve({ data: janela, error: null });
  };
  return fetchAll<{ id: number }>(build, "t").then((rows) => {
    const vistos = new Set(rows.map((r) => r.id));
    assertEquals(vistos.size, TOTAL, "a tabela inteira tem de voltar, mesmo com o cap menor");
    assertEquals(rows.length, TOTAL, "sem duplicata");
  });
});

Deno.test("fetchAllKeyset: mesmo cap menor, mesma exigência", () => {
  const todas = Array.from({ length: TOTAL }, (_, i) => ({ id: i }));
  let calls = 0;
  const build = (cursor: number | null, limite: number) => {
    calls++;
    if (calls > 40) throw new Error("laço não converge");
    const janela = todas.filter((l) => cursor === null || l.id > cursor)
      .slice(0, limite).slice(0, CAP_DO_SERVIDOR);
    return Promise.resolve({ data: janela, error: null });
  };
  return fetchAllKeyset<{ id: number }, number>(build, (l) => l.id, "t").then((rows) => {
    const vistos = new Set(rows.map((r) => r.id));
    assertEquals(vistos.size, TOTAL, "a tabela inteira tem de voltar sob cap menor");
    assertEquals(rows.length, TOTAL, "sem duplicata");
  });
});

Deno.test("fetchAll: tabela VAZIA continua terminando em 1 request", () => {
  // O critério novo é "página vazia", então o caso vazio não pode virar laço.
  let calls = 0;
  const build = () => {
    calls++;
    return Promise.resolve({ data: [] as Array<{ id: number }>, error: null });
  };
  return fetchAll<{ id: number }>(build, "t").then((rows) => {
    assertEquals(rows.length, 0);
    assertEquals(calls, 1);
  });
});
