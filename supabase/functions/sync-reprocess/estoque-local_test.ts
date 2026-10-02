// Testa o loader REAL de estoque-local.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/sync-reprocess/estoque-local_test.ts
//
// O gate `paginacao-delegada_test.ts` só lê `<edge>/index.ts` — a ordem estável deste loader
// (que mora fora do index justamente para não paginar no call-site) só é vigiada AQUI. O
// double registra o que cada PÁGINA pediu e aplica os filtros de verdade: um double que só
// registrasse mediria mais linhas do que a query devolveria (falso-verde).
import { carregarEstoqueLocalNaoZero } from "./estoque-local.ts";
import type { BancoPostgrest } from "../_shared/paginate.ts";
import { FalhaLeituraCritica } from "../_shared/leitura-critica.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

type Linha = Record<string, unknown>;
type Pagina = {
  tabela: string;
  colunas: string;
  filtros: string[];
  order: string | null;
  ascending: boolean | null;
  limit: number | null;
  range: [number, number] | null;
};

// Só os métodos que o loader usa; método ausente vira TypeError no teste (falha alta), nunca
// um verde por omissão. `aposPagina` muta a tabela ENTRE páginas — a escrita concorrente.
function fakeDb(linhas: Linha[], opts: { erroNaPagina?: number; aposPagina?: (n: number) => void } = {}) {
  const paginas: Pagina[] = [];
  function from(tabela: string) {
    const pg: Pagina = { tabela, colunas: "", filtros: [], order: null, ascending: null, limit: null, range: null };
    paginas.push(pg);
    const n = paginas.length;
    const predicados: Array<(l: Linha) => boolean> = [];
    const q = {
      select(colunas: string) {
        pg.colunas = colunas;
        return q;
      },
      eq(coluna: string, valor: unknown) {
        pg.filtros.push(`eq:${coluna}=${String(valor)}`);
        predicados.push((l) => l[coluna] === valor);
        return q;
      },
      not(coluna: string, operador: string, valor: unknown) {
        pg.filtros.push(`not:${coluna} ${operador} ${String(valor)}`);
        if (operador !== "eq") throw new Error(`double: .not(_, ${operador}) não implementado`);
        // NOT (col = v) do Postgres: NULL não passa (NULL = v é NULL, e NOT NULL é NULL).
        predicados.push((l) => l[coluna] !== null && l[coluna] !== undefined && l[coluna] !== valor);
        return q;
      },
      gt(coluna: string, valor: unknown) {
        pg.filtros.push(`gt:${coluna}`);
        predicados.push((l) => String(l[coluna]) > String(valor));
        return q;
      },
      order(coluna: string, o?: { ascending?: boolean }) {
        pg.order = coluna;
        pg.ascending = o?.ascending ?? true;
        return q;
      },
      limit(lim: number) {
        pg.limit = lim;
        return q;
      },
      range(de: number, ate: number) {
        pg.range = [de, ate];
        return q;
      },
      then<R>(resolve: (r: { data: Linha[] | null; error: { message: string; code?: string } | null }) => R) {
        if (opts.erroNaPagina === n) {
          return Promise.resolve(resolve({ data: null, error: { message: "canceling statement", code: "57014" } }));
        }
        const filtradas = linhas.filter((l) => predicados.every((p) => p(l)));
        const ordenadas = pg.order
          ? [...filtradas].sort((a, b) => (String(a[pg.order!]) < String(b[pg.order!]) ? -1 : 1))
          : filtradas;
        const [de, ate] = pg.range ?? [0, (pg.limit ?? ordenadas.length) - 1];
        const data = ordenadas.slice(de, ate + 1);
        opts.aposPagina?.(n);
        return Promise.resolve(resolve({ data, error: null }));
      },
    };
    return q;
  }
  return { db: { from } as unknown as BancoPostgrest, paginas };
}

function linhasBase(): Linha[] {
  const out: Linha[] = [];
  // 1.100 com estoque ≠ 0 na oben (atravessa a página de 1.000), 400 zeradas, 1 null, e a
  // colacor com estoque — nada disso pode vazar para o resultado.
  for (let i = 0; i < 1100; i++) {
    out.push({ id: `o${String(i).padStart(5, "0")}`, account: "oben", omie_codigo_produto: i + 1, estoque: i % 2 ? 3 : -1, codigo: `S${i}`, descricao: `D${i}` });
  }
  for (let i = 0; i < 400; i++) {
    out.push({ id: `z${String(i).padStart(5, "0")}`, account: "oben", omie_codigo_produto: 5000 + i, estoque: 0, codigo: `Z${i}`, descricao: `Z${i}` });
  }
  out.push({ id: "n00000", account: "oben", omie_codigo_produto: 9000, estoque: null, codigo: "N", descricao: "N" });
  out.push({ id: "c00000", account: "colacor", omie_codigo_produto: 9001, estoque: 8, codigo: "C", descricao: "C" });
  return out;
}

Deno.test("carregarEstoqueLocalNaoZero — só a conta e estoque ≠ 0, atravessando a página de 1.000", async () => {
  const { db } = fakeDb(linhasBase());
  const linhas = await carregarEstoqueLocalNaoZero(db, "oben");
  assertEquals(linhas.length, 1100);
  assertEquals(linhas.every((l) => l.estoque !== 0 && l.estoque !== null), true);
});

Deno.test("carregarEstoqueLocalNaoZero — KEYSET por id: toda página com os mesmos filtros, id asc e limite", async () => {
  const { db, paginas } = fakeDb(linhasBase());
  await carregarEstoqueLocalNaoZero(db, "oben");
  // 1.000 + 100 + a página vazia que encerra.
  assertEquals(paginas.length, 3);
  for (const pg of paginas) {
    assertEquals(pg.tabela, "omie_products");
    assertEquals(pg.colunas, "id, omie_codigo_produto, estoque, codigo, descricao");
    assertEquals(pg.filtros.slice(0, 2), ["eq:account=oben", "not:estoque eq 0"]);
    assertEquals([pg.order, pg.ascending, pg.limit, pg.range], ["id", true, 1000, null]);
  }
  assertEquals(paginas.map((p) => p.filtros.includes("gt:id")), [false, true, true]);
});

// O filtro `estoque ≠ 0` é sobre uma coluna que o sync_inventory de 30 min reescreve. Com
// OFFSET, uma linha que entra no recorte ATRÁS do cursor entre duas páginas empurra a janela e
// a última linha da página anterior volta DUPLICADA — e duplicata no mesmo upsert dá 21000
// ("cannot affect row a second time") no chunk inteiro. Keyset nunca relê o que já passou.
Deno.test("carregarEstoqueLocalNaoZero — linha que entra no recorte ENTRE páginas não duplica nada", async () => {
  const tabela = linhasBase();
  tabela.push({ id: "a00000", account: "oben", omie_codigo_produto: 7000, estoque: 0, codigo: "A", descricao: "A" });
  const { db } = fakeDb(tabela, {
    aposPagina: (n) => {
      if (n === 1) tabela.find((l) => l.id === "a00000")!.estoque = 4;
    },
  });
  const linhas = await carregarEstoqueLocalNaoZero(db, "oben");
  const ids = linhas.map((l) => l.id);
  assertEquals(ids.length, new Set(ids).size);
});

Deno.test("carregarEstoqueLocalNaoZero — página com erro LANÇA FalhaLeituraCritica (nunca vira lista vazia)", async () => {
  const { db } = fakeDb(linhasBase(), { erroNaPagina: 2 });
  let capturado: unknown = null;
  try {
    await carregarEstoqueLocalNaoZero(db, "oben");
  } catch (e) {
    capturado = e;
  }
  assertEquals(capturado instanceof FalhaLeituraCritica, true);
  const f = capturado as FalhaLeituraCritica;
  assertEquals([f.fonte, f.codigo], ["omie_products (estoque≠0)", "57014"]);
});
