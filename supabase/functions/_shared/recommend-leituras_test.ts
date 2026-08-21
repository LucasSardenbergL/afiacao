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
  CLUSTER_STATUS_COM_HISTORICO,
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
  colunas: string;
  order: string | null;
  // Guardado separado do nome da coluna: um `.order("id", {ascending:false})` mantém a ordem
  // ESTÁVEL (o gate textual passaria) e mesmo assim inverte QUAIS linhas entram num `.limit()`.
  ascending: boolean | null;
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
  opts: {
    erroEm?: string;
    codigo?: string;
    nulaEm?: string;
    /**
     * Roda DEPOIS de servir cada página, com a tabela e o nº da página. É o que torna a
     * escrita CONCORRENTE: mutar antes de servir só mudaria o estado inicial e a leitura
     * nem perceberia.
     */
    aoServirPagina?: (tabela: string, pagina: number) => void;
  } = {},
) {
  const registros: Registro[] = [];
  const paginasServidas: Record<string, number> = {};

  // Um registro por `from()` — ou seja, um por PÁGINA, que é o que permite afirmar que
  // TODA página (não só a primeira) foi pedida com `.order()` estável.
  function query(tabela: string): QueryPostgrest<Linha> {
    const reg: Registro = {
      tabela, colunas: "", order: null, ascending: null, filtros: [], ranges: [], limit: null, single: false,
    };
    registros.push(reg);
    // Os predicados filtram DE VERDADE: um double que registra o filtro sem aplicá-lo
    // mediria mais linhas do que a query devolveria, e o teste ficaria falso-verde.
    const predicados: Array<(l: Linha) => boolean> = [];

    function corpo(): Linha[] {
      const linhas = (porTabela[tabela] ?? []).filter((l) => predicados.every((p) => p(l)));
      // Ordena DE VERDADE: um double que só registra `.order()` deixa `ascending:false` verde,
      // e no cluster isso troca QUAIS 100 clientes entram na amostra (2ª rodada do Codex).
      if (reg.order) {
        const col = reg.order;
        linhas.sort((a, b) =>
          String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (reg.ascending === false ? -1 : 1)
        );
      }
      const alcance = reg.ranges[reg.ranges.length - 1];
      const servida = alcance
        ? linhas.slice(alcance[0], alcance[1] + 1)
        : linhas.slice(0, Math.min(reg.limit ?? CAP_POSTGREST, CAP_POSTGREST));
      if (opts.aoServirPagina) {
        paginasServidas[tabela] = (paginasServidas[tabela] ?? 0) + 1;
        opts.aoServirPagina(tabela, paginasServidas[tabela]);
      }
      return servida;
    }

    function resposta(): RespostaPostgrest<Linha> {
      if (opts.erroEm === tabela) {
        return { data: null, error: { message: "boom", code: opts.codigo ?? "57014" } };
      }
      // `data:null` SEM error: resposta MALFORMADA do PostgREST. Não é "lista vazia" —
      // é o EOF falso que `fetchAll`/`exigirLista` existem para rejeitar.
      if (opts.nulaEm === tabela) return { data: null, error: null };
      return { data: corpo(), error: null };
    }

    const q: QueryPostgrest<Linha> = {
      select(colunas: string) {
        reg.colunas = colunas;
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
      gt(coluna: string, valor: unknown) {
        reg.filtros.push(`gt:${coluna}`);
        // Compara como STRING: a chave real do keyset aqui é `id` (uuid), e um
        // `Number(uuid)` daria NaN — todo predicado viraria falso e o teste ficaria
        // verde por não devolver nada.
        predicados.push((l) => String(l[coluna] ?? "") > String(valor));
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
      order(coluna: string, opts?: { ascending?: boolean }) {
        reg.order = coluna;
        reg.ascending = opts?.ascending ?? true;
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
      // `is` entrou na interface pelo PR irmão (escritor único de `farmer_association_rules`),
      // que precisou de `.is('deleted_at', null)` para aplicar as DUAS metades do contrato do
      // universo de pedidos. Este núcleo não usa o predicado: LANÇA em vez de devolver `q` sem
      // filtrar, seguindo a convenção dos outros doubles deste `_shared` — um filtro que o
      // double ignora em silêncio faz o teste medir mais linhas do que a query devolveria.
      is(coluna: string) {
        throw new Error(`double: .is(${coluna}) não implementado neste núcleo`);
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

function scoresDoCluster(n: number, status: string | null = "ativo"): Linha[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${String(i).padStart(5, "0")}`,
    customer_user_id: `u${String(i).padStart(5, "0")}`,
    health_class: "critico",
    category_count: 1,
    // Sem esta coluna a whitelist de `carregarCluster` excluiria TODA linha do double, e as
    // asserções de cluster ficariam verdes medindo zero.
    sales_history_status: status,
  }));
}

/** Linhas do cluster com `id` CONTROLADO, para provar quem vence o `.order("id").limit()`. */
function linhasCluster(
  n: number,
  opts: { prefixoId: string; prefixoUser: string; status: string | null },
): Linha[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${opts.prefixoId}${String(i).padStart(5, "0")}`,
    customer_user_id: `${opts.prefixoUser}${String(i).padStart(5, "0")}`,
    health_class: "critico",
    category_count: 1,
    sales_history_status: opts.status,
  }));
}

Deno.test("cluster: .limit() é amostra deliberada, mas pedida com .order('id') — reprodutível", async () => {
  const { db, registros } = fakeDb({
    farmer_client_scores: scoresDoCluster(6185),
    order_items: itens(300, "u00000"),
  });
  const { clusterUserIds } = await carregarCluster(db, "critico");
  assertEquals(clusterUserIds.length, 100, "teto do cluster mudou sem o teste saber");
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

Deno.test("cluster: a amostra NO TETO é SINALIZADA (cap deliberado não é cap silencioso)", async () => {
  const muitos = Array.from({ length: TETO_CLUSTER_COMPRAS + 500 }, (_, i) => ({
    id: `i${String(i).padStart(6, "0")}`,
    product_id: `p${i % 50}`,
    customer_user_id: `u${String(i % TETO_CLUSTER_USUARIOS_AMOSTRA).padStart(5, "0")}`,
  }));
  const { db } = fakeDb({ farmer_client_scores: scoresDoCluster(60), order_items: muitos });
  const r = await carregarCluster(db, "critico");
  assertEquals(r.clusterPurchases.length, TETO_CLUSTER_COMPRAS);
  assertEquals(r.amostraNoTeto, true, "o teto da amostra não foi exposto no contrato");
});

// ── 7. Os buracos que a 2ª rodada do Codex encontrou nesta própria suíte ───────────────

Deno.test("tetos pinados por LITERAL — comparar com a constante importada é tautologia", () => {
  // Subir TETO_CLUSTER_CLIENTES para 1.000 mantinha tudo verde e dividia `sim` por 1.000
  // enquanto as compras seguiam vindo de 50: os cortes de cluster cairiam 10×.
  assertEquals(TETO_CLUSTER_CLIENTES, 100, "teto de clientes do cluster mudou");
  assertEquals(TETO_CLUSTER_USUARIOS_AMOSTRA, 50, "teto de usuários amostrados mudou");
  assertEquals(TETO_CLUSTER_COMPRAS, 1000, "teto de compras da amostra mudou");
  if (TETO_CLUSTER_USUARIOS_AMOSTRA > TETO_CLUSTER_CLIENTES) {
    throw new Error("amostrar mais usuários do que o cluster tem é incoerente");
  }
});

Deno.test("as colunas de DINHEIRO estão no .select() — tirar uma some com margem/EIP calado", () => {
  const { db, registros } = fakeDb(bancoCheio());
  return carregarInsumos(db, CLIENTE).then(() => {
    const colunasDe = (t: string) => registros.filter((r) => r.tabela === t).map((r) => r.colunas).join(" ");
    for (const col of ["cost_final", "cost_source", "cost_price", "cost_confidence", "product_id"]) {
      if (!colunasDe("product_costs").includes(col)) {
        throw new Error(`product_costs deixou de pedir '${col}' — custo some sem sinal`);
      }
    }
    for (const col of ["valor_unitario", "estoque", "id"]) {
      if (!colunasDe("omie_products").includes(col)) {
        throw new Error(`omie_products deixou de pedir '${col}' — preço/estoque somem sem sinal`);
      }
    }
  });
});

Deno.test("toda ordenação é ASCENDENTE — `ascending:false` é ordem estável que troca a amostra", async () => {
  const { db, registros } = fakeDb(bancoCheio());
  await carregarInsumos(db, CLIENTE);
  const descendentes = registros.filter((r) => r.order !== null && r.ascending === false);
  if (descendentes.length > 0) {
    throw new Error(`ordem descendente em: ${descendentes.map((r) => r.tabela).join(", ")}`);
  }
});

Deno.test("cluster: `ascending:false` mudaria QUAIS clientes entram (o double ordena de verdade)", async () => {
  const { db } = fakeDb({ farmer_client_scores: scoresDoCluster(6185) });
  const { clusterUserIds } = await carregarCluster(db, "critico");
  // Prova que a ordenação do double MORDE: ascendente pega o menor id, não um qualquer.
  assertEquals(clusterUserIds[0], "u00000", "a amostra não veio do começo da ordem");
  assertEquals(clusterUserIds[99], "u00099", "a amostra não é contígua na ordem pedida");
});

for (const tabela of ["omie_products", "product_costs", "order_items", "recommendation_config"]) {
  Deno.test(`\`data:null\` SEM error em ${tabela} LANÇA — malformada ≠ lista vazia`, async () => {
    const { db } = fakeDb(bancoCheio(), { nulaEm: tabela });
    const erro = await assertLanca(() => carregarInsumos(db, CLIENTE), `null em ${tabela}`);
    if (!(erro instanceof FalhaLeituraCritica)) {
      throw new Error(`esperava FalhaLeituraCritica, veio ${erro.name}: ${erro.message}`);
    }
  });
}

Deno.test("cluster: `data:null` SEM error LANÇA — é o que falsifica o exigirLista", async () => {
  const { db } = fakeDb({ farmer_client_scores: scoresDoCluster(10) }, { nulaEm: "farmer_client_scores" });
  const erro = await assertLanca(() => carregarCluster(db, "critico"), "cluster null");
  if (!(erro instanceof FalhaLeituraCritica)) {
    throw new Error(`esperava FalhaLeituraCritica, veio ${erro.name}: ${erro.message}`);
  }
});

Deno.test("o `code` do PostgREST SOBREVIVE ao envelope, e o texto do servidor NÃO", async () => {
  const { db } = fakeDb(bancoCheio(), { erroEm: "product_costs", codigo: "57014" });
  const erro = await assertLanca(() => carregarInsumos(db, CLIENTE), "custos");
  if (!(erro instanceof FalhaLeituraCritica)) throw new Error(`veio ${erro.name}`);
  // As duas metades juntas: diagnóstico preservado E mensagem pública fechada.
  assertEquals(erro.codigo, "57014", "o code do PostgREST se perdeu no envelope");
  if (!erro.message.includes("57014")) throw new Error(`o code não chegou à mensagem: ${erro.message}`);
  if (erro.message.includes("boom")) throw new Error(`texto do servidor vazou: ${erro.message}`);
});

Deno.test("`amostraNoTeto` diz só o que sabe: EXATAMENTE no teto, sem nada cortado, ainda é true", async () => {
  // O nome antigo ("saturada") afirmava "há mais compras" — com 1.000 existentes e 1.000
  // lidas, nada foi cortado. Provar `true` aqui é o que trava o nome honesto no lugar.
  const exatas = Array.from({ length: TETO_CLUSTER_COMPRAS }, (_, i) => ({
    id: `i${String(i).padStart(6, "0")}`,
    product_id: `p${i % 50}`,
    customer_user_id: `u${String(i % TETO_CLUSTER_USUARIOS_AMOSTRA).padStart(5, "0")}`,
  }));
  const { db } = fakeDb({ farmer_client_scores: scoresDoCluster(60), order_items: exatas });
  const r = await carregarCluster(db, "critico");
  assertEquals(r.clusterPurchases.length, TETO_CLUSTER_COMPRAS);
  assertEquals(r.amostraNoTeto, true, "no teto tem de ser sinalizado, mesmo sem corte");
});

// ── 8. Escrita CONCORRENTE durante a leitura paginada ────────────────────────────────
// Medido em prod (docs/historico/paginacao-offset-janela.md): `sync-reprocess` roda
// `15 */2 * * *` — inclusive 12:15/14:15/16:15 BRT — e faz `.delete().in('id', …)` em
// `order_items`, enquanto o `recommend` é on-demand e lê durante o expediente. Sob offset
// um DELETE antes do cursor desloca as páginas seguintes e uma linha VIVA nunca é lida.

Deno.test("order_items sob DELETE concorrente: a linha viva NÃO é pulada", async () => {
  const banco = bancoCheio();
  const { db } = fakeDb(banco, {
    aoServirPagina: (tabela, pagina) => {
      // Apaga uma linha JÁ SERVIDA na 1ª página: é isso que desloca o offset das seguintes.
      if (tabela === "order_items" && pagina === 1) {
        const i = banco.order_items.findIndex((l) => l.id === "i00000");
        if (i >= 0) banco.order_items.splice(i, 1);
      }
    },
  });
  const insumos = await carregarInsumos(db, CLIENTE);
  // Sob offset saem 2.848: o DELETE puxou tudo uma casa e `i01000` caiu no vão entre as
  // páginas 1 e 2. Sob keyset saem 2.849 — as 2.848 sobreviventes mais `i00000`, lida
  // antes de morrer (leitura não-repetível, que é outra classe e não se resolve aqui).
  assertEquals(insumos.orderItems.length, N_ITENS_DO_CLIENTE, "uma linha viva foi PULADA");
});

Deno.test("omie_products sob flip de ativo: nenhum SKU ativo some do catálogo", async () => {
  const banco = bancoCheio();
  // `omie-sync-status-produtos` (cron 03:30) espelha ativo/inativo em `omie_products` — o
  // `.eq('ativo',true)` do leitor é exatamente a coluna que ele reescreve, então o recorte
  // ENCOLHE no meio da leitura. É por isso que a tabela com 86 inserts e zero deletes é a
  // mais exposta do banco, e não as de milhões de updates.
  const { db } = fakeDb(banco, {
    aoServirPagina: (tabela, pagina) => {
      if (tabela === "omie_products" && pagina === 1) {
        const p = banco.omie_products.find((l) => l.id === "p00001");
        if (p) p.ativo = false;
      }
    },
  });
  const insumos = await carregarInsumos(db, CLIENTE);
  const lidos = new Set(insumos.products.map((p) => p.id));
  const aindaAtivos = banco.omie_products.filter((l) => l.ativo === true).map((l) => String(l.id));
  const sumiram = aindaAtivos.filter((id) => !lidos.has(id));
  // Contar não denuncia: 2.825 lidos para 2.825 ativos, com um SKU vivo trocado por outro
  // já inativado. Só a identidade denuncia.
  if (sumiram.length > 0) {
    throw new Error(`${sumiram.length} SKU(s) ATIVO(s) sumiram do catálogo: ${sumiram.slice(0, 3).join(", ")}`);

// ── 9. Desenho da AMOSTRA: quem entra no cluster é quem entra no DENOMINADOR de `sim` ──
//
// Eixo distinto do da seção 6 (que prova reprodutibilidade e exposição de falha). Aqui a
// pergunta é REPRESENTATIVIDADE: medido em prod 2026-08-21, o cluster `critico` tinha 6.185
// linhas, 5.406 delas (87%) `sem_historico`. Como `.order("id")` sobre UUID é sorteio estável,
// a amostra de 50 pegava ~42 linhas vazias — que contam no denominador e nunca no numerador.

Deno.test("amostra: `sem_historico` FICA DE FORA mesmo tendo os MENORES ids (87% do cluster em prod)", async () => {
  // Os `sem_historico` recebem os ids MENORES de propósito: sem o filtro eles VENCEM o
  // `.order("id").limit(100)` e tomam a amostra inteira. É a falsificação embutida — apagar
  // o `.in(...)` de `carregarCluster` faz este teste ficar vermelho, não verde por sorte.
  const vazias = linhasCluster(200, { prefixoId: "a", prefixoUser: "v", status: "sem_historico" });
  const comHistorico = linhasCluster(80, { prefixoId: "z", prefixoUser: "u", status: "ativo" });
  const { db } = fakeDb({
    farmer_client_scores: [...vazias, ...comHistorico],
    order_items: itens(10, "u00000"),
  });
  const r = await carregarCluster(db, "critico");
  assertEquals(r.clusterUserIds.length, 80, "linha `sem_historico` entrou na amostra");
  const intrusos = r.clusterUserIds.filter((id) => id.startsWith("v"));
  if (intrusos.length > 0) {
    throw new Error(`cliente sem histórico no cluster (${intrusos.length}) — o denominador volta a inflar`);
  }
});

Deno.test("amostra: `sales_history_status` NULL fica de fora — a coluna é NULLABLE em prod", async () => {
  // Zero nulos hoje, mas o schema permite. A whitelist POSITIVA decide isto explicitamente;
  // um `.neq('sem_historico')` excluiria NULL também, só que por efeito colateral invisível
  // (negação no PostgREST é NULL-blind) — e deixaria entrar um status NOVO de "sem venda".
  const nulos = linhasCluster(60, { prefixoId: "a", prefixoUser: "n", status: null });
  const ativos = linhasCluster(30, { prefixoId: "z", prefixoUser: "u", status: "ativo" });
  const { db } = fakeDb({ farmer_client_scores: [...nulos, ...ativos], order_items: itens(5, "u00000") });
  const r = await carregarCluster(db, "critico");
  assertEquals(r.clusterUserIds.length, 30, "linha com status NULL entrou na amostra");
});

Deno.test("amostra: um status DESCONHECIDO fica de fora (whitelist falha FECHADA)", async () => {
  // Se um dia nascer `sem_venda_valida`, ele NÃO deve entrar sozinho na amostra e reabrir o
  // defeito em silêncio. Whitelist exclui até alguém decidir; `.neq` incluiria.
  const novos = linhasCluster(60, { prefixoId: "a", prefixoUser: "x", status: "status_que_nao_existia" });
  const ativos = linhasCluster(30, { prefixoId: "z", prefixoUser: "u", status: "ativo" });
  const { db } = fakeDb({ farmer_client_scores: [...novos, ...ativos], order_items: itens(5, "u00000") });
  const r = await carregarCluster(db, "critico");
  assertEquals(r.clusterUserIds.length, 30, "status desconhecido entrou na amostra sem decisão");
});

Deno.test("amostra: `stale` ENTRA — são 705 dos 779 compradores `critico`, cortá-los esvazia o cluster", async () => {
  // Reduzir a whitelist a `["ativo"]` deixaria 74 clientes em `critico` (medido em prod) e
  // manteria os outros testes verdes. Este é o que morde.
  const { db } = fakeDb({
    farmer_client_scores: linhasCluster(40, { prefixoId: "s", prefixoUser: "u", status: "stale" }),
    order_items: itens(10, "u00000"),
  });
  const r = await carregarCluster(db, "critico");
  assertEquals(r.clusterUserIds.length, 40, "`stale` foi excluído — o cluster perde 90% dos compradores");
});

Deno.test("whitelist pinada por LITERAL — comparar com a constante importada é tautologia", () => {
  // Espelho de `SalesHistoryStatus` (src/lib/scoring/salesHistoryStatus.ts) menos
  // `sem_historico`. A paridade com a união de lá é gate de vitest
  // (src/__tests__/edge-money-path-invariants.test.ts): daqui o Deno não enxerga `src/`.
  assertEquals([...CLUSTER_STATUS_COM_HISTORICO], ["ativo", "stale"], "a whitelist da amostra mudou");
});

Deno.test("`usuariosAmostrados` é o DENOMINADOR — e DIFERE de `clusterUserIds`, que era o bug", async () => {
  const { db } = fakeDb({
    farmer_client_scores: scoresDoCluster(6185),
    order_items: itens(300, "u00000"),
  });
  const r = await carregarCluster(db, "critico");
  assertEquals(r.clusterUserIds.length, TETO_CLUSTER_CLIENTES, "leu um número de clientes diferente do teto");
  assertEquals(r.usuariosAmostrados.length, TETO_CLUSTER_USUARIOS_AMOSTRA, "amostrou um número diferente do teto");
  // A DIFERENÇA entre os dois é o defeito: o consumidor dividia por 100 o que contou sobre 50.
  if (r.usuariosAmostrados.length === r.clusterUserIds.length) {
    throw new Error("os dois tetos coincidiram — este teste deixou de vigiar o denominador");
  }
  assertEquals(
    r.usuariosAmostrados.join(","),
    r.clusterUserIds.slice(0, TETO_CLUSTER_USUARIOS_AMOSTRA).join(","),
    "`usuariosAmostrados` não é o prefixo exato de quem foi lido",
  );
});

Deno.test("as compras são pedidas SÓ dos amostrados — o `.in()` leva 50 ids, não 100", async () => {
  const { db, registros } = fakeDb({
    farmer_client_scores: scoresDoCluster(6185),
    order_items: itens(300, "u00000"),
  });
  await carregarCluster(db, "critico");
  const compras = registros.find((r) => r.tabela === "order_items");
  if (!compras) throw new Error("não pediu as compras do cluster");
  if (!compras.filtros.includes(`in:customer_user_id=${TETO_CLUSTER_USUARIOS_AMOSTRA}`)) {
    throw new Error(`o \`.in()\` das compras não levou ${TETO_CLUSTER_USUARIOS_AMOSTRA} ids: ${compras.filtros.join(", ")}`);
  }
});

Deno.test("o filtro de histórico é PEDIDO ao banco, não aplicado depois no cliente", async () => {
  // Filtrar em memória depois do `.limit(100)` devolveria menos de 100 elegíveis e voltaria a
  // misturar os dois eixos: o teto tem de cair sobre quem JÁ passou pelo filtro.
  const { db, registros } = fakeDb({
    farmer_client_scores: scoresDoCluster(6185),
    order_items: itens(300, "u00000"),
  });
  await carregarCluster(db, "critico");
  const cluster = registros.find((r) => r.tabela === "farmer_client_scores");
  if (!cluster) throw new Error("não pediu o cluster");
  if (!cluster.filtros.includes(`in:sales_history_status=${CLUSTER_STATUS_COM_HISTORICO.length}`)) {
    throw new Error(`o filtro de histórico não foi para a query: ${cluster.filtros.join(", ")}`);
  }
});
