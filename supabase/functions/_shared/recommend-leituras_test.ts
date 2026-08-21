// Testa o CÓDIGO REAL de recommend-leituras.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/recommend-leituras_test.ts
//
// Sem import remoto (jsr:/npm:) — `test:edges` roda com --no-remote e BLOQUEIA o CI. Por isso
// o assert é local (padrão de paginate_test.ts / mapas-paginados_test.ts) e o "banco" é um
// double que satisfaz `BancoPostgrest`, o contrato estrutural que os loaders pedem.
//
// O QUE ESTE ARQUIVO PROVA, e por que não dava pra provar antes: a edge `recommend/index.ts`
// importa `npm:@supabase/supabase-js@2`, então NUNCA roda sob --no-remote. Enquanto as seis
// leituras moravam lá dentro, "o catálogo volta inteiro" e "erro de leitura LANÇA" eram
// afirmações sem execução. Extrair a camada de leitura é o que torna as duas EXECUTÁVEIS.
import {
  carregarCluster,
  carregarInsumos,
  TETO_CLUSTER_CLIENTES,
  TETO_CLUSTER_COMPRAS,
  TETO_CLUSTER_USUARIOS_AMOSTRA,
} from "./recommend-leituras.ts";
import { FalhaLeituraCritica } from "./leitura-critica.ts";
import type { BancoPostgrest, QueryPostgrest, RespostaPostgrest } from "./paginate.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

async function assertLanca(fn: () => Promise<unknown>, msg: string): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error(`${msg}: NÃO lançou — a falha foi engolida`);
}

// Registro do que a query PEDIU. É o que torna o `.order()` uma asserção de verdade: sem
// ordenação estável o `.range()` pula/duplica linha entre páginas, e isso é invisível
// olhando só o resultado de um double que devolve as páginas já ordenadas.
type Registro = {
  tabela: string;
  order: string | null;
  filtros: string[];
  ranges: Array<[number, number]>;
  limit: number | null;
  single: boolean;
};

type Linha = Record<string, unknown>;

/**
 * O double SIMULA O CAP DE 1000 DO POSTGREST: sem `.range()` explícito ele corta em 1000
 * linhas, em silêncio, exatamente como o Data API real. Sem isso o teste seria VAZIO —
 * uma leitura não paginada devolveria a tabela inteira no double e passaria verde.
 * (É o mesmo `usouRange` de relatorio-mensal_test.ts.)
 */
const CAP_POSTGREST = 1000;

function fakeDb(
  porTabela: Record<string, Linha[]>,
  opts: { erroEm?: string; codigo?: string } = {},
) {
  const registros: Registro[] = [];

  // Um registro por `from()` — ou seja, um por PÁGINA, que é o que permite afirmar que
  // TODA página (não só a primeira) foi pedida com `.order()` estável.
  function query(tabela: string): QueryPostgrest<Linha> {
    const reg: Registro = { tabela, order: null, filtros: [], ranges: [], limit: null, single: false };
    registros.push(reg);
    // Os predicados filtram DE VERDADE: um double que registra o filtro sem aplicá-lo
    // mediria mais linhas do que a query devolveria, e o teste ficaria falso-verde.
    const predicados: Array<(l: Linha) => boolean> = [];

    function corpo(): Linha[] {
      const linhas = (porTabela[tabela] ?? []).filter((l) => predicados.every((p) => p(l)));
      const alcance = reg.ranges[reg.ranges.length - 1];
      if (alcance) return linhas.slice(alcance[0], alcance[1] + 1);
      const teto = reg.limit ?? CAP_POSTGREST;
      return linhas.slice(0, Math.min(teto, CAP_POSTGREST));
    }

    function resposta(): RespostaPostgrest<Linha> {
      if (opts.erroEm === tabela) {
        return { data: null, error: { message: "boom", code: opts.codigo ?? "57014" } };
      }
      return { data: corpo(), error: null };
    }

    const q: QueryPostgrest<Linha> = {
      select(_colunas: string) {
        return q;
      },
      eq(coluna: string, valor: unknown) {
        reg.filtros.push(`eq:${coluna}`);
        predicados.push((l) => l[coluna] === valor);
        return q;
      },
      in(coluna: string, valores: readonly unknown[]) {
        const alvo = new Set(valores);
        reg.filtros.push(`in:${coluna}=${valores.length}`);
        predicados.push((l) => alvo.has(l[coluna]));
        return q;
      },
      gte(coluna: string, valor: unknown) {
        reg.filtros.push(`gte:${coluna}`);
        predicados.push((l) => Number(l[coluna] ?? 0) >= Number(valor));
        return q;
      },
      lt(coluna: string, valor: unknown) {
        reg.filtros.push(`lt:${coluna}`);
        predicados.push((l) => Number(l[coluna] ?? 0) < Number(valor));
        return q;
      },
      not(coluna: string, operador: string, _valor: unknown) {
        reg.filtros.push(`not:${coluna} ${operador}`);
        return q;
      },
      order(coluna: string, _opts?: { ascending?: boolean }) {
        reg.order = coluna;
        return q;
      },
      range(de: number, ate: number) {
        reg.ranges.push([de, ate]);
        return q;
      },
      limit(n: number) {
        reg.limit = n;
        return q;
      },
      maybeSingle() {
        reg.single = true;
        const r = resposta();
        return Promise.resolve(
          r.error ? { data: null, error: r.error } : { data: (r.data ?? [])[0] ?? null, error: null },
        );
      },
      then<R1, R2>(
        resolve?: ((v: RespostaPostgrest<Linha>) => R1 | PromiseLike<R1>) | null,
        rejeitar?: ((motivo: unknown) => R2 | PromiseLike<R2>) | null,
      ): PromiseLike<R1 | R2> {
        return Promise.resolve(resposta()).then(resolve, rejeitar);
      },
    };
    return q;
  }

  // Duplo cast do TEST DOUBLE: `query` devolve sempre `QueryPostgrest<Linha>`, que não
  // satisfaz sozinho o `from<T>` genérico da interface real.
  const db = {
    from: <T>(tabela: string) => query(tabela) as unknown as QueryPostgrest<T>,
  } as BancoPostgrest;

  return { db, registros };
}

// ── Fixtures dimensionadas pela PROD medida em 2026-08-20 via psql-ro ──────────────────
const CLIENTE = "cliente-alvo";
const N_PRODUTOS = 3140; // omie_products WHERE ativo = true
const N_CUSTOS = 3676; // product_costs
const N_ITENS_DO_CLIENTE = 2849; // maior order_items por customer_user_id (8 clientes > 1000)

function produtos(n: number): Linha[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${String(i).padStart(5, "0")}`,
    omie_codigo_produto: i,
    descricao: `Produto ${i}`,
    codigo: `SKU${i}`,
    valor_unitario: 100,
    estoque: 5,
    familia: "f",
    subfamilia: "s",
    ativo: i % 10 !== 0 ? true : false, // 10% inativos: o filtro do double tem de morder
  }));
}

function custos(n: number): Linha[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${String(i).padStart(5, "0")}`,
    product_id: `p${String(i).padStart(5, "0")}`,
    cost_price: 60,
    cost_final: 60,
    cost_source: "PRODUCT_COST",
    cost_confidence: 1,
  }));
}

function itens(n: number, cliente: string): Linha[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `i${String(i).padStart(5, "0")}`,
    product_id: `p${String(i % 500).padStart(5, "0")}`,
    quantity: 1,
    unit_price: 100,
    customer_user_id: cliente,
  }));
}

function bancoCheio(extra: Record<string, Linha[]> = {}): Record<string, Linha[]> {
  return {
    recommendation_config: [{ id: "1", key: "w_assoc", value: 0.4 }],
    order_items: [
      ...itens(N_ITENS_DO_CLIENTE, CLIENTE),
      ...itens(30, "outro-cliente").map((l, i) => ({ ...l, id: `z${i}` })),
    ],
    omie_products: produtos(N_PRODUTOS),
    product_costs: custos(N_CUSTOS),
    farmer_association_rules: [
      { id: "r1", antecedent_product_ids: ["p00001"], consequent_product_ids: ["p00002"], lift: 2, confidence: 0.5, support: 0.1 },
      { id: "r2", antecedent_product_ids: ["p00003"], consequent_product_ids: ["p00004"], lift: 1.0, confidence: 0.5, support: 0.1 },
    ],
    farmer_client_scores: [{ id: "s1", customer_user_id: CLIENTE, health_class: "critico", category_count: 3 }],
    ...extra,
  };
}

const ATIVOS_ESPERADOS = produtos(N_PRODUTOS).filter((p) => p.ativo === true).length;

// ── 1. O defeito: as leituras grandes voltavam capadas em 1000 ─────────────────────────

Deno.test("catálogo de 3.140 ativos volta INTEIRO (não os 1.000 do cap do PostgREST)", async () => {
  const { db } = fakeDb(bancoCheio());
  const insumos = await carregarInsumos(db, CLIENTE);
  assertEquals(insumos.products.length, ATIVOS_ESPERADOS, "catálogo truncado");
  if (insumos.products.length <= CAP_POSTGREST) {
    throw new Error("o teste ficou vazio: a fixture não passa do cap");
  }
});

Deno.test("product_costs de 3.676 volta INTEIRO — custo ausente por truncagem vira 'SKU sem custo'", async () => {
  const { db } = fakeDb(bancoCheio());
  const insumos = await carregarInsumos(db, CLIENTE);
  assertEquals(insumos.costs.length, N_CUSTOS, "custos truncados");
});

Deno.test("order_items do cliente de 2.849 volta INTEIRO — e só do cliente pedido", async () => {
  const { db } = fakeDb(bancoCheio());
  const insumos = await carregarInsumos(db, CLIENTE);
  assertEquals(insumos.orderItems.length, N_ITENS_DO_CLIENTE, "itens do cliente truncados");
});

Deno.test("farmer_association_rules pagina e aplica o piso de lift/support", async () => {
  const { db } = fakeDb(bancoCheio());
  const insumos = await carregarInsumos(db, CLIENTE);
  // r2 tem lift 1.0 < 1.2 → o double filtra de verdade, então só r1 sobrevive.
  assertEquals(insumos.rules.map((r) => r.id), ["r1"], "piso de lift/support não aplicado");
});

// ── 2. Controle de calibração: o double CAPA de verdade ────────────────────────────────
// Sem este teste, "voltou inteiro" poderia ser só o double devolvendo tudo — e o gate
// aprovaria uma leitura NÃO paginada. Ele prova que o cap existe no double.

Deno.test("controle: leitura SEM .range() no double é capada em 1.000 (o teste não é vazio)", async () => {
  const { db } = fakeDb(bancoCheio());
  const semRange = await db.from<Linha>("omie_products").select("id").eq("ativo", true);
  assertEquals(semRange.data?.length, CAP_POSTGREST, "o double não simula o cap — os testes acima são teatro");
});

// ── 3. Toda página pediu ordem ESTÁVEL ─────────────────────────────────────────────────

Deno.test("todo .range() foi pedido com .order('id') — a PK, estável entre páginas", async () => {
  const { db, registros } = fakeDb(bancoCheio());
  await carregarInsumos(db, CLIENTE);
  const paginadas = registros.filter((r) => r.ranges.length > 0);
  if (paginadas.length < 4) {
    throw new Error(`só ${paginadas.length} leituras paginaram — esperava ≥4 (produtos, custos, itens, regras)`);
  }
  const semOrdem = paginadas.filter((r) => r.order !== "id");
  if (semOrdem.length > 0) {
    throw new Error(`.range() sem .order('id') em: ${semOrdem.map((r) => r.tabela).join(", ")}`);
  }
});

// ── 4. Erro de leitura LANÇA — não vira catálogo parcial nem default silencioso ────────

for (
  const tabela of [
    "recommendation_config",
    "order_items",
    "omie_products",
    "product_costs",
    "farmer_association_rules",
    "farmer_client_scores",
  ]
) {
  Deno.test(`erro em ${tabela} LANÇA (não é engolido em recomendação sobre dado parcial)`, async () => {
    const { db } = fakeDb(bancoCheio(), { erroEm: tabela });
    await assertLanca(() => carregarInsumos(db, CLIENTE), `erro em ${tabela}`);
  });
}

Deno.test("erro em recommendation_config NÃO deixa os pesos caírem nos defaults hard-coded", async () => {
  const { db } = fakeDb(bancoCheio(), { erroEm: "recommendation_config" });
  const erro = await assertLanca(() => carregarInsumos(db, CLIENTE), "config");
  if (!(erro instanceof FalhaLeituraCritica)) {
    throw new Error(`esperava FalhaLeituraCritica, veio ${erro.name}: ${erro.message}`);
  }
});

Deno.test("erro em farmer_client_scores NÃO deixa o health_class cair no default silencioso", async () => {
  const { db } = fakeDb(bancoCheio(), { erroEm: "farmer_client_scores" });
  const erro = await assertLanca(() => carregarInsumos(db, CLIENTE), "client score");
  if (!(erro instanceof FalhaLeituraCritica)) {
    throw new Error(`esperava FalhaLeituraCritica, veio ${erro.name}: ${erro.message}`);
  }
});

Deno.test("a mensagem do erro não vaza texto do servidor (domínio fechado)", async () => {
  const { db } = fakeDb(bancoCheio(), { erroEm: "omie_products" });
  const erro = await assertLanca(() => carregarInsumos(db, CLIENTE), "produtos");
  if (erro.message.includes("boom")) {
    throw new Error(`mensagem do servidor vazou para o cliente: ${erro.message}`);
  }
});

// ── 5. Ausência LEGÍTIMA continua sendo ausência (não virou erro) ──────────────────────

Deno.test("cliente sem score: data null SEM error devolve null — ausência ≠ falha", async () => {
  const { db } = fakeDb(bancoCheio({ farmer_client_scores: [] }));
  const insumos = await carregarInsumos(db, CLIENTE);
  assertEquals(insumos.clientScore, null, "ausência de score virou outra coisa");
});

Deno.test("cliente sem histórico: lista vazia é estado legítimo, não erro", async () => {
  const { db } = fakeDb(bancoCheio({ order_items: [] }));
  const insumos = await carregarInsumos(db, CLIENTE);
  assertEquals(insumos.orderItems.length, 0);
});

// ── 6. Cluster: amostra deliberada, mas DETERMINÍSTICA e que expõe falha ───────────────

function scoresDoCluster(n: number): Linha[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${String(i).padStart(5, "0")}`,
    customer_user_id: `u${String(i).padStart(5, "0")}`,
    health_class: "critico",
    category_count: 1,
  }));
}

Deno.test("cluster: .limit() é amostra deliberada, mas pedida com .order('id') — reprodutível", async () => {
  const { db, registros } = fakeDb({
    farmer_client_scores: scoresDoCluster(6185),
    order_items: itens(300, "u00000"),
  });
  const { clusterUserIds } = await carregarCluster(db, "critico");
  assertEquals(clusterUserIds.length, TETO_CLUSTER_CLIENTES, "teto do cluster mudou sem o teste saber");
  const semOrdem = registros.filter((r) => r.limit !== null && r.order !== "id");
  if (semOrdem.length > 0) {
    throw new Error(`amostra sem ordem estável em: ${semOrdem.map((r) => r.tabela).join(", ")}`);
  }
});

Deno.test("cluster: erro em farmer_client_scores LANÇA (sim_score não some em silêncio)", async () => {
  const { db } = fakeDb({ farmer_client_scores: scoresDoCluster(10) }, { erroEm: "farmer_client_scores" });
  await assertLanca(() => carregarCluster(db, "critico"), "cluster");
});

Deno.test("cluster: erro em order_items LANÇA", async () => {
  const { db } = fakeDb({ farmer_client_scores: scoresDoCluster(10), order_items: itens(10, "u00000") }, { erroEm: "order_items" });
  await assertLanca(() => carregarCluster(db, "critico"), "compras do cluster");
});

Deno.test("cluster vazio: nenhuma compra buscada e nenhum erro (health_class sem ninguém)", async () => {
  const { db, registros } = fakeDb({ farmer_client_scores: scoresDoCluster(5) });
  const r = await carregarCluster(db, "misto");
  assertEquals(r.clusterUserIds.length, 0);
  assertEquals(r.clusterPurchases.length, 0);
  // `.in()` com lista vazia é round-trip inútil — e no PostgREST real é `in.()`, forma degenerada.
  assertEquals(registros.filter((x) => x.tabela === "order_items").length, 0, "buscou compras de cluster vazio");
});

Deno.test("cluster: a amostra saturada é SINALIZADA (cap deliberado não é cap silencioso)", async () => {
  const muitos = Array.from({ length: TETO_CLUSTER_COMPRAS + 500 }, (_, i) => ({
    id: `i${String(i).padStart(6, "0")}`,
    product_id: `p${i % 50}`,
    customer_user_id: `u${String(i % TETO_CLUSTER_USUARIOS_AMOSTRA).padStart(5, "0")}`,
  }));
  const { db } = fakeDb({ farmer_client_scores: scoresDoCluster(60), order_items: muitos });
  const r = await carregarCluster(db, "critico");
  assertEquals(r.clusterPurchases.length, TETO_CLUSTER_COMPRAS);
  assertEquals(r.amostraSaturada, true, "saturação da amostra não foi exposta no contrato");
});
