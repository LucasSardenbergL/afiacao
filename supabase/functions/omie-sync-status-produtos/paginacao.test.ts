// Testa a paginação concorrente PURA da omie-sync-status-produtos (coletarProdutosAlvo).
// Rodar: deno test supabase/functions/omie-sync-status-produtos/paginacao.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { coletarProdutosAlvo, type OmieProduto, type PaginaOmie } from "./paginacao.ts";

const OPTS = { concurrency: 4, maxPaginas: 500, maxDuracaoMs: 120_000 };

// Catálogo fake: `total` produtos (código 1..total), servidos `pageSize` por página. Página > fim = [].
// `declararTotal` simula o total_de_paginas do Omie (default = real; menor = sub-report).
function catalogoFake(total: number, pageSize: number, declararTotal?: number) {
  const totalPaginas = declararTotal ?? Math.ceil(total / pageSize);
  return (pagina: number): Promise<PaginaOmie> => {
    const start = (pagina - 1) * pageSize;
    const produtos: OmieProduto[] = [];
    for (let i = start; i < Math.min(start + pageSize, total); i++) {
      produtos.push({ codigo_produto: i + 1, inativo: i % 2 === 0 ? "S" : "N" });
    }
    return Promise.resolve({ produtos, totalPaginas });
  };
}

Deno.test("espelha prod: 3676 produtos @100/pág, coleta só os alvos, inclusive o da ÚLTIMA página", async () => {
  const alvoSet = new Set(["10", "1500", "3676"]); // 3676 = último produto, na página 37 (a última)
  const res = await coletarProdutosAlvo(catalogoFake(3676, 100), alvoSet, OPTS);
  assertEquals(res.paginasProcessadas, 37); // 3676/100 = 37 páginas não-vazias
  assertEquals(res.encontrados.size, 3);
  assertEquals(res.produtos.length, 3);
  // O bug de "parar cedo" perderia o 3676 → falsifica.
  assert(res.encontrados.has("3676"), "produto da última página não pode ser perdido (money-path)");
});

Deno.test("catálogo exato múltiplo da concorrência: não perde nem duplica na fronteira", async () => {
  const alvoSet = new Set(["1", "400"]);
  const res = await coletarProdutosAlvo(catalogoFake(400, 100), alvoSet, OPTS);
  assertEquals(res.paginasProcessadas, 4);
  assertEquals(res.produtos.length, 2);
  assert(res.encontrados.has("400"));
});

Deno.test("SUB-REPORT: total_de_paginas menor que o real → continua até vazio, não perde o tail", async () => {
  // 700 produtos reais (7 páginas) mas o Omie DECLARA só 5. Piso=5, mas seguimos até a vazia.
  const alvoSet = new Set(["50", "650"]); // 650 está na página 7 (além do piso declarado)
  const res = await coletarProdutosAlvo(catalogoFake(700, 100, 5), alvoSet, OPTS);
  assertEquals(res.paginasProcessadas, 7);
  assert(res.encontrados.has("650"), "SKU além do total_de_paginas declarado não pode ser perdido");
});

Deno.test("ANOMALIA: página vazia ANTES do piso (fault transiente) → LANÇA, não trata como fim", async () => {
  // Declara 10 páginas, mas a página 3 volta vazia (simula 200+fault / página malformada).
  const comBuraco = (pagina: number): Promise<PaginaOmie> =>
    Promise.resolve(
      pagina === 3
        ? { produtos: [], totalPaginas: 10 }
        : { produtos: [{ codigo_produto: pagina }], totalPaginas: 10 },
    );
  await assertRejects(
    () => coletarProdutosAlvo(comBuraco, new Set(["7"]), OPTS),
    Error,
    "anti-parada-prematura",
  );
});

Deno.test("página 1 vazia (catálogo veio vazio) → paginasProcessadas=0 (o chamador trata como anômalo)", async () => {
  const vazioTotal = (): Promise<PaginaOmie> => Promise.resolve({ produtos: [], totalPaginas: 1 });
  const res = await coletarProdutosAlvo(vazioTotal, new Set(["1"]), OPTS);
  assertEquals(res.paginasProcessadas, 0);
  assertEquals(res.produtos.length, 0);
});

Deno.test("nunca excede o teto de concorrência", async () => {
  let emVoo = 0;
  let pico = 0;
  const fetchPagina = async (pagina: number): Promise<PaginaOmie> => {
    emVoo++;
    pico = Math.max(pico, emVoo);
    await new Promise((r) => setTimeout(r, 5));
    emVoo--;
    return { produtos: pagina <= 25 ? [{ codigo_produto: pagina }] : [], totalPaginas: 25 };
  };
  await coletarProdutosAlvo(fetchPagina, new Set(), OPTS);
  assertEquals(pico, 4);
});

Deno.test("de-dup: mesmo código repetido em páginas distintas conta uma vez", async () => {
  const fetchPagina = (pagina: number): Promise<PaginaOmie> =>
    Promise.resolve(
      pagina <= 3
        ? { produtos: [{ codigo_produto: 7 }], totalPaginas: 3 }
        : { produtos: [], totalPaginas: 3 },
    );
  const res = await coletarProdutosAlvo(fetchPagina, new Set(["7"]), OPTS);
  assertEquals(res.produtos.length, 1);
  assertEquals(res.encontrados.size, 1);
});

Deno.test("guard de tempo: coleta que passa de maxDuracaoMs LANÇA antes do kill do runtime", async () => {
  // Página 1 sozinha já dorme 20ms; maxDuracaoMs=5 → o 1º worker do pool aborta na 1ª checagem.
  const lento = (pagina: number): Promise<PaginaOmie> =>
    new Promise((r) =>
      setTimeout(() => r({ produtos: [{ codigo_produto: pagina }], totalPaginas: 999 }), 20)
    );
  await assertRejects(
    () => coletarProdutosAlvo(lento, new Set(["1"]), { ...OPTS, maxDuracaoMs: 5 }),
    Error,
    "antes do kill do runtime",
  );
});

Deno.test("guard anti-loop: catálogo que nunca esvazia lança em vez de rodar pra sempre", async () => {
  const nuncaVazia = (pagina: number): Promise<PaginaOmie> =>
    Promise.resolve({ produtos: [{ codigo_produto: pagina }], totalPaginas: 9999 });
  await assertRejects(
    () => coletarProdutosAlvo(nuncaVazia, new Set(["1"]), { ...OPTS, maxPaginas: 20 }),
    Error,
    "anti-loop",
  );
});
