// Testa o CÓDIGO REAL de mapas-paginados.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/mapas-paginados_test.ts
//
// Sem import remoto (jsr:/npm:) — `test:edges` roda com --no-remote e BLOQUEIA o CI.
// Por isso o assert é local (mesmo padrão de paginate_test.ts) e o "banco" é um double
// que satisfaz `BancoPostgrest`, o contrato estrutural que os loaders pedem.
import {
  carregarCarteiraComElegibilidade,
  carregarExcluidosDaCarteira,
  carregarOwnerMap,
  carregarPedidosDoMes,
  carregarProductMap,
} from "./mapas-paginados.ts";
import type { BancoPostgrest, QueryPostgrest, RespostaPostgrest } from "./paginate.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

// Registro do que a query PEDIU. É o que torna o `.order()` uma asserção de verdade:
// sem ordenação estável o .range() pula/duplica linha entre páginas, e isso é invisível
// olhando só o resultado de um double que devolve as páginas em ordem.
type Registro = {
  tabela: string;
  colunas: string;
  order: string | null;
  filtros: string[];
  ranges: Array<[number, number]>;
};

type Linha = Record<string, unknown>;

function fakeDb(
  porTabela: Record<string, Linha[]>,
  opts: { falhaNaPagina?: number; erro?: string } = {},
) {
  const registros: Registro[] = [];
  const paginasPedidas: Record<string, number> = {};

  // Um registro por `from()` — ou seja, um por PÁGINA, que é o que permite afirmar que
  // TODA página (não só a primeira) foi pedida com `.order()` estável.
  function query(tabela: string): QueryPostgrest<Linha> {
    const reg: Registro = { tabela, colunas: "", order: null, filtros: [], ranges: [] };
    registros.push(reg);
    // Os predicados filtram DE VERDADE: um double que registra o filtro sem aplicá-lo
    // mediria mais linhas do que a query devolveria, e o teste ficaria falso-verde.
    const predicados: Array<(l: Linha) => boolean> = [];

    const q: QueryPostgrest<Linha> = {
      select(colunas: string) {
        reg.colunas = colunas;
        return q;
      },
      eq(coluna: string, valor: unknown) {
        reg.filtros.push(`eq:${coluna}=${String(valor)}`);
        predicados.push((l) => l[coluna] === valor);
        return q;
      },
      in(coluna: string, valores: readonly unknown[]) {
        const alvo = new Set(valores);
        reg.filtros.push(`in:${coluna}=${valores.join(",")}`);
        predicados.push((l) => alvo.has(l[coluna]));
        return q;
      },
      gte(coluna: string, valor: unknown) {
        reg.filtros.push(`gte:${coluna}=${String(valor)}`);
        predicados.push((l) => String(l[coluna] ?? "") >= String(valor));
        return q;
      },
      lt(coluna: string, valor: unknown) {
        reg.filtros.push(`lt:${coluna}=${String(valor)}`);
        predicados.push((l) => String(l[coluna] ?? "") < String(valor));
        return q;
      },
      not(coluna: string, operador: string, valor: unknown) {
        reg.filtros.push(`not:${coluna} ${operador} ${String(valor)}`);
        if (operador !== "in") throw new Error(`double: .not(_, ${operador}) não implementado`);
        const fora = new Set(
          String(valor).replace(/^\(|\)$/g, "").split(",").map((s) => s.trim()),
        );
        predicados.push((l) => !fora.has(String(l[coluna])));
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
      then<R1, R2>(
        resolve?: ((v: RespostaPostgrest<Linha>) => R1 | PromiseLike<R1>) | null,
        rejeitar?: ((motivo: unknown) => R2 | PromiseLike<R2>) | null,
      ): PromiseLike<R1 | R2> {
        const n = paginasPedidas[tabela] ?? 0;
        paginasPedidas[tabela] = n + 1;
        // Como o PostgREST falha de verdade: data:null + error preenchido.
        const resposta: RespostaPostgrest<Linha> = opts.falhaNaPagina === n
          ? { data: null, error: { message: opts.erro ?? "boom" } }
          : {
            data: (() => {
              const [de, ate] = reg.ranges[reg.ranges.length - 1] ?? [0, 999];
              const linhas = (porTabela[tabela] ?? []).filter((l) =>
                predicados.every((p) => p(l))
              );
              return linhas.slice(de, ate + 1);
            })(),
            error: null,
          };
        return Promise.resolve(resposta).then(resolve, rejeitar);
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

function assignments(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    customer_user_id: `c${i}`,
    owner_user_id: `o${i}`,
    eligible: i % 2 === 0,
  }));
}

// ── carregarOwnerMap ────────────────────────────────────────────────────────

Deno.test("ownerMap: monta customer→owner a partir das linhas", async () => {
  const { db } = fakeDb({ carteira_assignments: assignments(3) });
  const mapa = await carregarOwnerMap(db);
  assertEquals(mapa.size, 3);
  assertEquals(mapa.get("c0"), "o0");
  assertEquals(mapa.get("c2"), "o2");
});

Deno.test("ownerMap: página com ERRO lança — não devolve mapa parcial", async () => {
  // O defeito original: a 2ª página falha, o loop lê `data:null` como fim de tabela e
  // devolve as 1000 primeiras como se fossem a carteira inteira. Quem consome cai no
  // fallback `?? farmer_id` e ATRIBUI o score ao vendedor errado, em silêncio.
  const { db } = fakeDb({ carteira_assignments: assignments(2500) }, {
    falhaNaPagina: 1,
    erro: "canceling statement due to statement timeout",
  });
  let lancou = false;
  try {
    await carregarOwnerMap(db);
  } catch (e) {
    lancou = true;
    assertEquals(
      (e as Error).message,
      "carteira_assignments: canceling statement due to statement timeout",
    );
  }
  assertEquals(lancou, true, "carregarOwnerMap devolveu mapa PARCIAL em vez de lançar");
});

Deno.test("ownerMap: atravessa o cap de 1000 (não trunca a carteira)", async () => {
  const { db, registros } = fakeDb({ carteira_assignments: assignments(2500) });
  const mapa = await carregarOwnerMap(db);
  assertEquals(mapa.size, 2500);
  assertEquals(mapa.get("c2499"), "o2499");
  assertEquals(registros.length, 3); // 1000 + 1000 + 500
});

Deno.test("ownerMap: TODA página pede .order() estável na chave", async () => {
  const { db, registros } = fakeDb({ carteira_assignments: assignments(2500) });
  await carregarOwnerMap(db);
  // Sem .order() o Postgres não garante a mesma sequência entre requests: a página 2
  // pode repetir linha da 1 e PULAR outra — cliente somindo da carteira em silêncio.
  // customer_user_id é UNIQUE em prod (carteira_assignments_customer_user_id_key).
  assertEquals(registros.length, 3);
  for (const reg of registros) {
    assertEquals(reg.order, "customer_user_id", "página paginada sem .order() estável");
  }
});

// ── carregarCarteiraComElegibilidade ────────────────────────────────────────

Deno.test("carteira: devolve as linhas com eligible, ordenado e completo", async () => {
  const { db, registros } = fakeDb({ carteira_assignments: assignments(1200) });
  const linhas = await carregarCarteiraComElegibilidade(db);
  assertEquals(linhas.length, 1200);
  assertEquals(linhas[0], { customer_user_id: "c0", owner_user_id: "o0", eligible: true });
  assertEquals(registros[0].order, "customer_user_id");
});

Deno.test("carteira: página com ERRO lança — snapshot parcial não é snapshot", async () => {
  // O snapshot mensal é CONGELADO e idempotente por (mes, customer_user_id): uma carteira
  // parcial vira um mês fechado com clientes faltando, indistinguível do real depois.
  const { db } = fakeDb({ carteira_assignments: assignments(2500) }, { falhaNaPagina: 2 });
  let lancou = false;
  try {
    await carregarCarteiraComElegibilidade(db);
  } catch (e) {
    lancou = true;
    assertEquals((e as Error).message, "carteira_assignments: boom");
  }
  assertEquals(lancou, true, "carregarCarteiraComElegibilidade devolveu lista PARCIAL");
});

// ── carregarPedidosDoMes ────────────────────────────────────────────────────

function pedidos(n: number, status = "faturado", data = "2026-06-15") {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    customer_user_id: `c${i}`,
    total: 100 + i,
    order_date_kpi: data,
    status,
  }));
}

Deno.test("pedidos do mês: filtra status/janela e ordena por id", async () => {
  const { db, registros } = fakeDb({
    sales_orders: [
      ...pedidos(2),
      ...pedidos(1, "cancelado"),
      ...pedidos(1, "faturado", "2026-05-31"), // fora da janela (antes)
      ...pedidos(1, "faturado", "2026-07-01"), // fora da janela (depois)
    ],
  });
  const linhas = await carregarPedidosDoMes(db, "2026-06-01", "2026-07-01");
  assertEquals(linhas.length, 2);
  assertEquals(registros[0].order, "id");
  assertEquals(registros[0].filtros, [
    "not:status in (cancelado,rascunho,pendente)",
    "gte:order_date_kpi=2026-06-01",
    "lt:order_date_kpi=2026-07-01",
  ]);
});

Deno.test("pedidos do mês: página com ERRO lança — não vira receita 0", async () => {
  // Este é o pior caller: a página perdida não some da tela, ela vira
  // `had_order_in_month:false` + `revenue_month:0` GRAVADO para um cliente que comprou.
  // "Não consegui ler" carimbado como "não comprou" — §2, ausente ≠ zero.
  const { db } = fakeDb({ sales_orders: pedidos(1500) }, {
    falhaNaPagina: 1,
    erro: "canceling statement due to statement timeout",
  });
  let lancou = false;
  try {
    await carregarPedidosDoMes(db, "2026-06-01", "2026-07-01");
  } catch (e) {
    lancou = true;
    assertEquals(
      (e as Error).message,
      "sales_orders: canceling statement due to statement timeout",
    );
  }
  assertEquals(lancou, true, "carregarPedidosDoMes devolveu lista PARCIAL");
});

Deno.test("pedidos do mês: atravessa o cap de 1000", async () => {
  const { db } = fakeDb({ sales_orders: pedidos(2300) });
  const linhas = await carregarPedidosDoMes(db, "2026-06-01", "2026-07-01");
  assertEquals(linhas.length, 2300);
});

// ── carregarExcluidosDaCarteira ─────────────────────────────────────────────

Deno.test("excluídos: monta o Set e filtra por excluir_da_carteira", async () => {
  const { db, registros } = fakeDb({
    cliente_classificacao: [
      { user_id: "u1", excluir_da_carteira: true },
      { user_id: "u2", excluir_da_carteira: true },
      { user_id: "u3", excluir_da_carteira: false },
    ],
  });
  const set = await carregarExcluidosDaCarteira(db);
  assertEquals(set.size, 2);
  assertEquals(set.has("u1"), true);
  assertEquals(set.has("u3"), false);
  assertEquals(registros[0].filtros, ["eq:excluir_da_carteira=true"]);
  assertEquals(registros[0].order, "user_id");
});

Deno.test("excluídos: página com ERRO lança — não devolve Set parcial", async () => {
  // Set parcial = fornecedor marcado p/ exclusão volta a entrar no fan-out do decay.
  const { db } = fakeDb(
    {
      cliente_classificacao: Array.from({ length: 1500 }, (_, i) => ({
        user_id: `u${i}`,
        excluir_da_carteira: true,
      })),
    },
    { falhaNaPagina: 1, erro: "permission denied" },
  );
  let lancou = false;
  try {
    await carregarExcluidosDaCarteira(db);
  } catch (e) {
    lancou = true;
    assertEquals((e as Error).message, "cliente_classificacao: permission denied");
  }
  assertEquals(lancou, true, "carregarExcluidosDaCarteira devolveu Set PARCIAL");
});

// ── carregarProductMap ──────────────────────────────────────────────────────

function produtos(n: number, account: string, sufixo = "") {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}${sufixo}`,
    omie_codigo_produto: 1000 + i,
    account,
  }));
}

Deno.test("productMap: monta código→product_id filtrando por account", async () => {
  const { db, registros } = fakeDb({
    omie_products: [...produtos(2, "colacor"), ...produtos(2, "oben", "-oben")],
  });
  const mapa = await carregarProductMap(db, "colacor");
  assertEquals(mapa.size, 2);
  assertEquals(mapa.get(1000), "p0");
  // O filtro por account é money-path: o MESMO código existe em >1 empresa (UNIQUE é
  // (omie_codigo_produto, account)) e resolver account-blind grava o custo de uma
  // empresa no product_id de outra. Ver _shared/product-idmap.ts.
  assertEquals(registros[0].filtros, ["eq:account=colacor"]);
  assertEquals(registros[0].order, "id");
});

Deno.test("productMap: página com ERRO lança — não devolve mapa parcial", async () => {
  // Mapa parcial = produto legítimo vira `product_id: null` no item do pedido, e o
  // sync GRAVA esse null. Perda silenciosa de vínculo, persistida.
  const { db } = fakeDb({ omie_products: produtos(1500, "colacor") }, {
    falhaNaPagina: 1,
    erro: "boom",
  });
  let lancou = false;
  try {
    await carregarProductMap(db, "colacor");
  } catch (e) {
    lancou = true;
    assertEquals((e as Error).message, "omie_products: boom");
  }
  assertEquals(lancou, true, "carregarProductMap devolveu mapa PARCIAL");
});

Deno.test("productMap: atravessa o cap de 1000", async () => {
  const { db } = fakeDb({ omie_products: produtos(2300, "colacor") });
  const mapa = await carregarProductMap(db, "colacor");
  assertEquals(mapa.size, 2300);
  assertEquals(mapa.get(3299), "p2299");
});

Deno.test("productMap: código inválido/ausente não vira chave 0", async () => {
  // Number(null) === 0 fabricaria a chave 0 e daria match em produto inexistente.
  const { db } = fakeDb({
    omie_products: [
      { id: "p1", omie_codigo_produto: null, account: "colacor" },
      { id: null, omie_codigo_produto: 55, account: "colacor" },
      { id: "p3", omie_codigo_produto: 0, account: "colacor" },
      { id: "p4", omie_codigo_produto: -7, account: "colacor" },
      { id: "p5", omie_codigo_produto: 77, account: "colacor" },
    ],
  });
  const mapa = await carregarProductMap(db, "colacor");
  assertEquals(mapa.size, 1);
  assertEquals(mapa.get(77), "p5");
  assertEquals(mapa.has(0), false);
});

Deno.test("productMap: código string do PostgREST vira chave numérica", async () => {
  // O lookup a jusante usa o NÚMERO vindo da API Omie (prod.codigo_produto). Se a chave
  // entrasse como string, TODO lookup erraria e todo item viraria product_id null.
  const { db } = fakeDb({
    omie_products: [{ id: "p9", omie_codigo_produto: "4321", account: "colacor" }],
  });
  const mapa = await carregarProductMap(db, "colacor");
  assertEquals(mapa.get(4321), "p9");
});
