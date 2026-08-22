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
     * Resposta da `.rpc()`. O double NÃO reimplementa a agregação SQL de propósito: um double
     * que refaz a lógica prova o double, não a função. O SQL de verdade está provado
     * EXECUTANDO em `db/test-recommend-cluster-agregado.sh` (PG17, 25 asserts + 6
     * falsificações). O que se prova AQUI é a TRADUÇÃO — que o TypeScript lê a resposta sem
     * transformar ausência em zero, e que lança no que é malformado.
     */
    rpcResposta?: { data: unknown[] | null; error: { message: string; code?: string } | null };
    erroEmRpc?: boolean;
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
  const chamadasRpc: Array<{ fn: string; args: Record<string, unknown> }> = [];

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
    rpc: <T>(fn: string, args: Record<string, unknown>) => {
      chamadasRpc.push({ fn, args });
      if (opts.erroEmRpc) {
        return Promise.resolve({ data: null, error: { message: "boom do servidor", code: "57014" } });
      }
      // Sem `rpcResposta` explícita: uma linha plausível, para os testes que não são sobre a RPC.
      const r = opts.rpcResposta ??
        { data: [{ denominador: 3, observados: 2, produtos: { p1: 2 }, truncado: false }], error: null };
      return Promise.resolve(r) as unknown as PromiseLike<
        { data: T[] | null; error: { message: string; code?: string | null } | null }
      >;
    },
  } as BancoPostgrest;

  return { db, registros, chamadasRpc };
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

// O nome e os parâmetros são CONTRATO com a migration 20260822000358 — se um lado mudar
// sozinho, a edge chama uma função que não existe e o `sim` some em runtime, não no CI.
const RPC_CLUSTER = "recommend_cluster_agregado";

Deno.test("cluster: chama a RPC de agregação com o nome e os parâmetros da migration", async () => {
  const { db, chamadasRpc } = fakeDb({});
  await carregarCluster(db, "critico");
  assertEquals(chamadasRpc.length, 1, "não chamou a RPC exatamente uma vez");
  assertEquals(chamadasRpc[0].fn, RPC_CLUSTER, "nome da RPC divergiu da migration");
  assertEquals(chamadasRpc[0].args.p_health_class, "critico");
  assertEquals(chamadasRpc[0].args.p_teto_clientes, TETO_CLUSTER_CLIENTES);
});

Deno.test("cluster: a agregação NÃO volta para o TypeScript (era ela que trazia o teto junto)", async () => {
  // O defeito consertado era estrutural: agregar no edge obrigava a LER as linhas, e ler linhas
  // obrigava a um teto. Se alguém reintroduzir a leitura de `order_items` aqui, o teto volta
  // atrás dela — por isso o assert é sobre a AUSÊNCIA da leitura, não sobre o resultado.
  const { db, registros } = fakeDb({
    farmer_client_scores: scoresDoCluster(6185),
    order_items: itens(5000, "u00000"),
  });
  await carregarCluster(db, "critico");
  const lidas = registros.map((r) => r.tabela);
  for (const t of ["order_items", "farmer_client_scores"]) {
    if (lidas.includes(t)) {
      throw new Error(`carregarCluster voltou a ler ${t} linha a linha — o teto volta junto`);
    }
  }
});

Deno.test("cluster: o agregado de 1.312 produtos volta INTEIRO (uma linha não passa pelo cap de 1.000)", async () => {
  // Esta é a armadilha que quase reabriu o defeito. Em prod o agregado tem 957 / 1.312 / 1.109
  // produtos por cluster, e o PostgREST capa em 1.000 EM SILÊNCIO — inclusive `.rpc()`. Uma RPC
  // linha-por-produto truncaria DOIS dos três clusters hoje. O double capa em `CAP_POSTGREST`
  // igual ao real, então este teste falharia se o contrato voltasse a ser linha-por-produto.
  const muitos: Record<string, number> = {};
  for (let i = 0; i < 1312; i++) muitos[`p${String(i).padStart(5, "0")}`] = (i % 40) + 1;
  const { db } = fakeDb({}, {
    rpcResposta: { data: [{ denominador: 348, observados: 334, produtos: muitos, truncado: false }], error: null },
  });
  const r = await carregarCluster(db, "atencao");
  assertEquals(Object.keys(r.clientesPorProduto ?? {}).length, 1312, "o agregado voltou truncado");
  assertEquals(r.denominador, 348);
  assertEquals(r.observados, 334);
});

Deno.test("cluster: denominador é a POPULAÇÃO, e `observados` DIVERGE dele (não é o mesmo número)", async () => {
  // Em prod divergem: 779 vs 633 em `critico`. Se o contrato colapsasse os dois num campo só, a
  // escolha de denominador viraria invisível — e ela muda quais produtos cruzam os cortes.
  const { db } = fakeDb({}, {
    rpcResposta: { data: [{ denominador: 779, observados: 633, produtos: { p1: 75 }, truncado: false }], error: null },
  });
  const r = await carregarCluster(db, "critico");
  assertEquals(r.denominador, 779, "denominador deixou de ser a população elegível");
  assertEquals(r.observados, 633, "observados colapsou no denominador");
  if (r.denominador === r.observados) throw new Error("os dois campos viraram o mesmo número");
});

Deno.test("cluster TRUNCADO: os campos medidos vêm NULL, não 0 nem {} (ausente ≠ zero)", async () => {
  // O coração da entrega. `observados: 0` diria "medi e ninguém comprou"; `produtos: {}` diria a
  // mesma coisa de outra forma. Os dois seriam o zero fabricado que o teto de 1.000 produzia.
  const { db } = fakeDb({}, {
    rpcResposta: { data: [{ denominador: 90000, observados: null, produtos: null, truncado: true }], error: null },
  });
  const r = await carregarCluster(db, "critico");
  assertEquals(r.truncado, true);
  assertEquals(r.observados, null, "observados virou número sob truncagem");
  assertEquals(r.clientesPorProduto, null, "produtos virou {} sob truncagem — é o zero fabricado");
  assertEquals(r.denominador, 90000, "o denominador é FATO mesmo truncado — some junto era perda de sinal");
});

Deno.test("cluster VAZIO é estado legítimo e distinto de truncado (aqui o vazio É medido)", async () => {
  const { db } = fakeDb({}, {
    rpcResposta: { data: [{ denominador: 0, observados: 0, produtos: {}, truncado: false }], error: null },
  });
  const r = await carregarCluster(db, "misto");
  assertEquals(r.denominador, 0);
  assertEquals(r.observados, 0, "cluster vazio observou 0 DE VERDADE — aqui 0 não é fabricação");
  assertEquals(r.clientesPorProduto, {}, "cluster vazio devolve {} medido, não null");
  assertEquals(r.truncado, false);
});

Deno.test("cluster: erro na RPC LANÇA (sim_score não some em silêncio)", async () => {
  const { db } = fakeDb({}, { erroEmRpc: true });
  const e = await assertLanca(() => carregarCluster(db, "critico"), "cluster");
  // Domínio FECHADO: o `catch` do Deno.serve devolve `error.message` no CORPO da resposta, e o
  // MESSAGE do Postgres pode interpolar valor de linha.
  if (e.message.includes("boom do servidor")) {
    throw new Error(`o texto do servidor vazou na mensagem pública: ${e.message}`);
  }
});

Deno.test("cluster: `data: null` sem erro LANÇA — malformada não é cluster vazio", async () => {
  const { db } = fakeDb({}, { rpcResposta: { data: null, error: null } });
  await assertLanca(() => carregarCluster(db, "critico"), "rpc malformada");
});

Deno.test("cluster: RPC de UMA linha que volta ZERO linhas LANÇA (não vira denominador 0)", async () => {
  // Sem este assert, `data: []` cairia num `?? {}` e o cluster inteiro pareceria vazio — um
  // denominador 0 fabricado a partir de uma resposta quebrada.
  const { db } = fakeDb({}, { rpcResposta: { data: [], error: null } });
  await assertLanca(() => carregarCluster(db, "critico"), "rpc sem linha");
});

// ── 7. Os buracos que a 2ª rodada do Codex encontrou nesta própria suíte ───────────────

Deno.test("teto pinado por LITERAL — comparar com a constante importada é tautologia", () => {
  // O teto mudou de NATUREZA nesta entrega: era amostra (100 lidos / 50 medidos / 1.000 linhas
  // de compra), virou DISJUNTOR de custo. Baixá-lo para perto da população real (779 no maior
  // cluster) faria a RPC recusar medir em silêncio e `sim` sumir do ranking em produção.
  assertEquals(TETO_CLUSTER_CLIENTES, 5000, "teto do disjuntor do cluster mudou");
  // Folga sobre o maior cluster medido em prod (779 elegíveis em `critico`, 2026-08-22). Se um
  // dia isto apertar, é decisão de produto — não pode acontecer por acidente.
  if (TETO_CLUSTER_CLIENTES < 779 * 2) {
    throw new Error("o disjuntor ficou perto demais da população real medida (779)");
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

for (const tabela of ["omie_products", "product_costs", "order_items", "recommendation_config"]) {
  Deno.test(`\`data:null\` SEM error em ${tabela} LANÇA — malformada ≠ lista vazia`, async () => {
    const { db } = fakeDb(bancoCheio(), { nulaEm: tabela });
    const erro = await assertLanca(() => carregarInsumos(db, CLIENTE), `null em ${tabela}`);
    if (!(erro instanceof FalhaLeituraCritica)) {
      throw new Error(`esperava FalhaLeituraCritica, veio ${erro.name}: ${erro.message}`);
    }
  });
}

Deno.test("cluster: a falha da RPC é FalhaLeituraCritica, com o `code` preservado", async () => {
  const { db } = fakeDb({}, { erroEmRpc: true });
  const erro = await assertLanca(() => carregarCluster(db, "critico"), "cluster rpc");
  if (!(erro instanceof FalhaLeituraCritica)) {
    throw new Error(`esperava FalhaLeituraCritica, veio ${erro.name}: ${erro.message}`);
  }
  assertEquals(erro.codigo, "57014", "o code do PostgREST se perdeu no envelope da RPC");
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
  }
});

// ── 9. Desenho da AMOSTRA: quem entra no cluster é quem entra no DENOMINADOR de `sim` ──
//
// Eixo distinto do da seção 6 (que prova reprodutibilidade e exposição de falha). Aqui a
// pergunta é REPRESENTATIVIDADE: medido em prod 2026-08-21, o cluster `critico` tinha 6.185
// linhas, 5.406 delas (87%) `sem_historico`. Como `.order("id")` sobre UUID é sorteio estável,
// a amostra de 50 pegava ~42 linhas vazias — que contam no denominador e nunca no numerador.

// ⚠️ ONDE ESTA PROVA FOI PARAR. Quatro testes viviam aqui exercitando a whitelist contra
// `carregarCluster` (sem_historico fora, NULL fora, status desconhecido fora, `stale` DENTRO).
// O filtro migrou para o SQL da RPC, então eles não têm mais o que exercitar neste runtime — e
// mantê-los contra um double que reimplementasse o SQL provaria o double. A cobertura não caiu,
// mudou de camada: `db/test-recommend-cluster-agregado.sh` prova as quatro EXECUTANDO em PG17
// (assert A4) e a falsificação F2 abre a whitelist e exige o vermelho. O que sobra aqui é o
// espelho — a constante que os dois gates de paridade comparam.

Deno.test("a whitelist de status ainda é ESPELHO — o valor mudou de lugar, não de dono", () => {
  // O filtro migrou para o SQL da RPC (provado EXECUTANDO em db/test-recommend-cluster-agregado.sh:
  // 'sem_historico' e NULL fora do denominador, com falsificação). A constante segue aqui porque
  // ela é o espelho que o gate de paridade compara — com `SalesHistoryStatus` de src/ no vitest, e
  // com o literal da migration. Se ela sumir, os dois gates ficam sem um dos lados.
  // Literal, não comparação com a própria constante: o `as const` já faz o TypeScript rejeitar
  // `sem_historico` aqui em tempo de compilação, então um assert sobre isso seria tautologia.
  // O que este pino vigia é a MUDANÇA silenciosa do valor.
  assertEquals([...CLUSTER_STATUS_COM_HISTORICO], ["ativo", "stale"], "a whitelist mudou");
});
