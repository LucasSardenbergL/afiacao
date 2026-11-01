// Roda o CÓDIGO REAL de catalogo-gravacao.ts (N2: falha de upsert do catálogo não vira sucesso).
import {
  type ClienteUpsert,
  concluirSyncProdutos,
  desfechoSyncProdutos,
  erroComFalhasAcumuladas,
  gravarPaginaCatalogo,
  MARCA_FALHA_GRAVACAO,
  novasFalhasCatalogo,
} from "./catalogo-gravacao.ts";

// Asserções locais em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
function assert(cond: boolean, msg = "assert falhou"): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}
function assertStrictEquals(a: unknown, b: unknown) {
  if (a !== b) throw new Error(`assertStrictEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

/** Duplo do cliente: o upsert da página em `paginasQueFalham` devolve erro; registra as chamadas. */
function clienteFake(paginasQueFalham: Set<number>) {
  const chamadas: Array<{ tabela: string; linhas: number; onConflict: string }> = [];
  let paginaAtual = 0;
  const db: ClienteUpsert = {
    from(tabela) {
      return {
        upsert(linhas, opcoes) {
          chamadas.push({ tabela, linhas: linhas.length, onConflict: opcoes.onConflict });
          const falha = paginasQueFalham.has(paginaAtual);
          return Promise.resolve({ error: falha ? { message: "permission denied for table omie_products" } : null });
        },
      };
    },
  };
  return { db, chamadas, naPagina: (p: number) => { paginaAtual = p; } };
}

const linhas = (n: number) => Array.from({ length: n }, (_, i) => ({ omie_codigo_produto: i + 1, account: "oben" }));

/** Simula o laço de páginas do syncProducts: 3 páginas de 100, 100 e 40 linhas. */
async function rodarTresPaginas(paginasQueFalham: Set<number>) {
  const { db, chamadas, naPagina } = clienteFake(paginasQueFalham);
  const falhas = novasFalhasCatalogo();
  let totalSynced = 0;
  for (const [pagina, n] of [[1, 100], [2, 100], [3, 40]] as const) {
    naPagina(pagina);
    totalSynced += (await gravarPaginaCatalogo(db, linhas(n), pagina, falhas)).gravadas;
  }
  const resultado = { totalSynced, totalPaginas: 3, lastPage: 3, nextPage: null, complete: true };
  return { desfecho: desfechoSyncProdutos(resultado, falhas), chamadas, falhas };
}

Deno.test("erro de upsert numa página: run vira falha (500, success false, marca do ramo, cursor na página)", async () => {
  const { desfecho, chamadas, falhas } = await rodarTresPaginas(new Set([2]));

  // As páginas seguintes continuam sendo gravadas (linha correta não causa dano).
  assertEquals(chamadas.length, 3);
  assertEquals(falhas.paginas, [2]);
  assertStrictEquals(falhas.linhas, 100);

  assertStrictEquals(desfecho.ok, false);
  assertStrictEquals(desfecho.status, 500);
  assertStrictEquals(desfecho.corpo.success, false);
  assert(desfecho.ok === false && desfecho.erro.startsWith(`${MARCA_FALHA_GRAVACAO}: 100 linha(s) em 1 pagina(s) [2]`));
  assertStrictEquals(desfecho.corpo.error, desfecho.ok === false ? desfecho.erro : null);
  assertStrictEquals(desfecho.corpo.totalSynced, 140);
  assertStrictEquals(desfecho.corpo.complete, false);
  assertStrictEquals(desfecho.corpo.nextPage, 2);
  assertEquals(desfecho.corpo.paginasFalhas, [2]);
  assertStrictEquals(desfecho.corpo.linhasFalhas, 100);
});

Deno.test("várias páginas falhando: conta todas, cursor na PRIMEIRA, mensagem da primeira", async () => {
  const { desfecho } = await rodarTresPaginas(new Set([3, 1]));
  assertStrictEquals(desfecho.status, 500);
  assertStrictEquals(desfecho.corpo.success, false);
  assertStrictEquals(desfecho.corpo.totalSynced, 100);
  assertStrictEquals(desfecho.corpo.linhasFalhas, 140);
  assertEquals(desfecho.corpo.paginasFalhas, [1, 3]);
  assertStrictEquals(desfecho.corpo.nextPage, 1);
  assert(desfecho.ok === false && desfecho.erro.endsWith("permission denied for table omie_products"));
});

Deno.test("caminho feliz: corpo idêntico ao de antes ({ success: true, ...resultado }), mesmo upsert", async () => {
  const { desfecho, chamadas } = await rodarTresPaginas(new Set());
  assertStrictEquals(desfecho.ok, true);
  assertStrictEquals(desfecho.status, 200);
  assertEquals(desfecho.corpo, { success: true, totalSynced: 240, totalPaginas: 3, lastPage: 3, nextPage: null, complete: true });
  assertEquals(chamadas.map((c) => [c.tabela, c.onConflict]), Array(3).fill(["omie_products", "omie_codigo_produto,account"]));
});

Deno.test("página sem linhas (tudo filtrado): não chama o upsert e não conta como falha", async () => {
  const { db, chamadas } = clienteFake(new Set([1]));
  const falhas = novasFalhasCatalogo();
  assertEquals(await gravarPaginaCatalogo(db, [], 1, falhas), { gravadas: 0, erro: null });
  assertStrictEquals(chamadas.length, 0);
  assertEquals(falhas, novasFalhasCatalogo());
});

/** Duplo do finalizador do log (completeVendaSync): registra cada chamada. */
function finalizadorFake() {
  const chamadas: Array<{ corpo: Record<string, unknown>; erro: string }> = [];
  return { chamadas, finalizar: (corpo: Record<string, unknown>, erro: string) => { chamadas.push({ corpo, erro }); return Promise.resolve(); } };
}

Deno.test("fronteira da action com falha: finaliza o log UMA vez como erro (com contadores) e devolve 500", async () => {
  const { db, naPagina } = clienteFake(new Set([1]));
  const falhas = novasFalhasCatalogo();
  naPagina(1);
  const { gravadas } = await gravarPaginaCatalogo(db, linhas(30), 1, falhas);
  const resultado = { totalSynced: gravadas, totalPaginas: 1, lastPage: 1, nextPage: null, complete: true };
  const log = finalizadorFake();

  const saida = await concluirSyncProdutos(resultado, falhas, log.finalizar);

  assertStrictEquals(saida.status, 500);
  assertStrictEquals(saida.corpo.success, false);
  assertStrictEquals(log.chamadas.length, 1);
  // A mensagem passada ao finalizador é o que vira fin_sync_log.status='error' + error_message.
  assert(log.chamadas[0].erro.startsWith(`${MARCA_FALHA_GRAVACAO}: 30 linha(s) em 1 pagina(s) [1]`));
  assertStrictEquals(log.chamadas[0].corpo.linhasFalhas, 30);
  assertStrictEquals(log.chamadas[0].corpo.success, false);
});

Deno.test("fronteira da action sem falha: 200, corpo de sempre, NÃO finaliza o log (o epílogo comum fecha 'complete')", async () => {
  const resultado = { totalSynced: 10, totalPaginas: 1, lastPage: 1, nextPage: null, complete: true };
  const log = finalizadorFake();
  const saida = await concluirSyncProdutos(resultado, novasFalhasCatalogo(), log.finalizar);
  assertStrictEquals(saida.status, 200);
  assertEquals(saida.corpo, { success: true, ...resultado });
  assertStrictEquals(log.chamadas.length, 0);
});

Deno.test("exceção depois de falha de gravação: a mensagem carrega a contagem e o erro original", () => {
  const falhas = { paginas: [2], linhas: 100, primeiraMensagem: "timeout" };
  const e = erroComFalhasAcumuladas(new Error("Omie 429 esgotado"), falhas);
  assert(e instanceof Error);
  assert(e.message.startsWith(`${MARCA_FALHA_GRAVACAO}: 100 linha(s) em 1 pagina(s) [2]`));
  assert(e.message.endsWith("e o run abortou depois: Omie 429 esgotado"));
});

Deno.test("exceção sem falha de gravação: devolve o MESMO erro (outras falhas inalteradas)", () => {
  const original = new Error("Omie 429 esgotado");
  assertStrictEquals(erroComFalhasAcumuladas(original, novasFalhasCatalogo()), original);
});
